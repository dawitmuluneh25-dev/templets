import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Pool } from 'pg';
import { z } from 'zod';

import { withTenant, type Tx } from '@reporting/db';
import { TOKEN_SCHEMA_VERSION, contentHash, serialize } from '@reporting/tokens';

/**
 * Template import: the corpus artefact becomes rows a report can actually be authored on.
 *
 * Until this existed, the corpus produced 427 validated templates and the database held
 * whatever the tests had seeded — a proven pipeline with nothing on the end of it.
 *
 * Four rules, in order:
 *
 * 1. **The artefact is validated, not trusted.** It is a file on disk that a build step
 *    produced; a hand edit or a stale copy is a realistic failure. Shape is checked with
 *    zod, and every entry must reproduce its own body from its own tokens.
 * 2. **Identity is the source id, not the name.** 427 files share 327 labels (0006);
 *    matching on names would merge distinct protocols into one template.
 * 3. **A re-run is a no-op.** Version identity is the content hash, so importing the same
 *    artefact twice adds nothing, and an import of a *changed* artefact adds version 2
 *    rather than overwriting the text a signed report was authored on.
 * 4. **One bad template does not hide the other 426.** Rejections are collected and
 *    reported with a reason; the caller decides what to do with a non-empty list, and the
 *    CLI exits non-zero so CI cannot mistake a partial import for a clean one.
 *
 * What is deliberately *not* here: renaming a template whose label changed upstream.
 * `external_id` is identity, the label is display text, and rewriting clinical-facing
 * text during an import is exactly the kind of silent alteration ADR-0004 forbids.
 */

/** Where the corpus build writes its machine input, relative to the repository root. */
const ARTEFACT_RELATIVE = path.join('corpus', 'generated', 'templates.json');

/**
 * The corpus records status in its own vocabulary. The schema's vocabulary is smaller and
 * is about what the library offers, not about what the exporter thought.
 */
const STATUS: Readonly<Record<string, 'active' | 'deprecated'>> = {
  Active: 'active',
  Inactive: 'deprecated',
};

const tokenSchema = z.looseObject({ kind: z.string().min(1) });

/**
 * The corpus is not uniform here: 130 entries carry a list of modalities and 297 carry a
 * single string, and one carries an empty one. All three are facts about the export, so
 * the importer normalises the shape and keeps the value — including blank. Rejecting a
 * template because its modality label is missing would withhold a valid template; filling
 * in "UNKNOWN" would put a word in the clinical record that the export never said.
 */
const modalitySchema = z
  .union([z.array(z.string()), z.string()])
  .transform((value) => (Array.isArray(value) ? value : [value]));

/**
 * Deliberately loose on token *contents*: the token union belongs to `@reporting/tokens`,
 * and duplicating it here would be a second definition that drifts. What is asserted is
 * that the entry can reproduce its body — the same invariant the corpus gate uses.
 */
const artefactEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  base_name: z.string().min(1),
  variant_label: z.string().nullable(),
  scope: z.string().min(1),
  modality: modalitySchema,
  type: z.string().min(1),
  status: z.string().min(1),
  provenance: z.enum(['org_authored', 'third_party', 'unattributed', 'unknown']),
  guid: z.string(),
  schema_version: z.number().int(),
  source_relpath: z.string().min(1),
  char_count: z.number().int().nonnegative(),
  sections: z.array(z.string()),
  fields: z.array(z.looseObject({ key: z.string() })),
  tokens: z.array(tokenSchema).min(1),
});

interface Candidate {
  readonly entry: z.infer<typeof artefactEntrySchema>;
  readonly body: string;
  readonly digest: string;
}

export interface RejectedTemplate {
  readonly id: string;
  readonly name: string;
  readonly reason: string;
}

export interface TemplateImportReport {
  readonly source: string;
  readonly entries: number;
  readonly templates_created: number;
  readonly templates_existing: number;
  readonly versions_created: number;
  readonly versions_unchanged: number;
  readonly rejected: readonly RejectedTemplate[];
  readonly by_provenance: Readonly<Record<string, number>>;
  readonly dry_run: boolean;
}

export interface TemplateImportDeps {
  readonly pool: Pool;
}

export interface ImportTemplatesInput {
  readonly orgId: string;
  /** Recorded as `template_version.created_by` when the version is new. */
  readonly actorId?: string;
  readonly artefactPath?: string;
  readonly dryRun?: boolean;
}

/** Resolves the artefact from the module location, so it does not depend on the cwd. */
export function defaultArtefactPath(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, ARTEFACT_RELATIVE);
    if (fs.existsSync(candidate)) return candidate;

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return path.resolve(process.cwd(), ARTEFACT_RELATIVE);
}

function readArtefact(file: string): unknown {
  if (!fs.existsSync(file)) {
    throw new Error(
      `No corpus artefact at ${file}. Run \`pnpm corpus\` to generate it, then import again.`,
    );
  }

  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Validates one entry and derives the three things the database needs from it: the body,
 * the token document, and the hash that identifies the version.
 *
 * The body is reconstructed from the tokens rather than read from the artefact, because
 * the artefact has no body — and because a stored body that disagrees with its token
 * stream is a template that renders differently from the report signed on it.
 */
function accept(raw: unknown): Candidate | RejectedTemplate {
  const parsed = artefactEntrySchema.safeParse(raw);

  if (!parsed.success) {
    const id = (raw as { id?: unknown })?.id;

    return {
      id: typeof id === 'string' ? id : '(unidentified)',
      name: '(unidentified)',
      reason: `shape: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    };
  }

  const entry = parsed.data;

  if (entry.schema_version !== TOKEN_SCHEMA_VERSION) {
    return {
      id: entry.id,
      name: entry.name,
      reason: `token schema ${entry.schema_version} is not ${TOKEN_SCHEMA_VERSION}`,
    };
  }

  const status = STATUS[entry.status];

  if (status === undefined) {
    return {
      id: entry.id,
      name: entry.name,
      reason: `status "${entry.status}" has no database equivalent`,
    };
  }

  let body: string;

  try {
    body = serialize(entry.tokens as never);
  } catch (error) {
    return {
      id: entry.id,
      name: entry.name,
      reason: `tokens do not serialise: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (body.length !== entry.char_count) {
    return {
      id: entry.id,
      name: entry.name,
      reason: `body is ${body.length} characters but the artefact recorded ${entry.char_count}`,
    };
  }

  if (body.trim() === '') {
    return { id: entry.id, name: entry.name, reason: 'body is empty' };
  }

  return {
    entry,
    body,
    digest: contentHash({ schema_version: TOKEN_SCHEMA_VERSION, tokens: entry.tokens as never }),
  };
}

function isRejection(value: Candidate | RejectedTemplate): value is RejectedTemplate {
  return 'reason' in value;
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const value of [...values].sort()) {
    counts[value] = (counts[value] ?? 0) + 1;
  }

  return counts;
}

interface TenantState {
  /** external_id -> template id */
  readonly templates: Map<string, string>;
  /** `${templateId}:${contentHash}` for every version the tenant already has. */
  readonly versions: Set<string>;
  readonly maxVersion: Map<string, number>;
}

/** Everything the write loop needs to know, in two queries rather than two per template. */
async function loadTenantState(tx: Tx, orgId: string): Promise<TenantState> {
  const templates = await tx.query<{ id: string; external_id: string }>(
    'select id, external_id from template where org_id = $1 and external_id is not null',
    [orgId],
  );

  const versions = await tx.query<{ template_id: string; content_hash: string; version: number }>(
    'select template_id, content_hash, version from template_version where org_id = $1',
    [orgId],
  );

  const byExternalId = new Map<string, string>();
  for (const row of templates.rows) byExternalId.set(row.external_id, row.id);

  const versionKeys = new Set<string>();
  const maxVersion = new Map<string, number>();

  for (const row of versions.rows) {
    versionKeys.add(`${row.template_id}:${row.content_hash}`);
    maxVersion.set(row.template_id, Math.max(maxVersion.get(row.template_id) ?? 0, row.version));
  }

  return { templates: byExternalId, versions: versionKeys, maxVersion };
}

async function upsertTemplate(
  tx: Tx,
  orgId: string,
  candidate: Candidate,
  templates: ReadonlyMap<string, string>,
): Promise<{ id: string; created: boolean }> {
  const { entry } = candidate;

  const found = templates.get(entry.id);

  if (found !== undefined) return { id: found, created: false };

  const inserted = await tx.query<{ id: string }>(
    `insert into template
       (org_id, name, base_name, variant_label, external_id, scope, modality, type,
        provenance, licence_status, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'user_provided', $10)
     returning id`,
    [
      orgId,
      entry.name,
      entry.base_name,
      entry.variant_label,
      entry.id,
      entry.scope,
      entry.modality.join(','),
      entry.type,
      JSON.stringify({
        class: entry.provenance,
        guid: entry.guid,
        source_relpath: entry.source_relpath,
        modality: entry.modality,
        sections: entry.sections.length,
        // Recorded, not enforced (ADR-0009): these templates are the customer's property.
        rights_basis: 'user_provided',
      }),
      STATUS[entry.status],
    ],
  );

  const id = inserted.rows[0]?.id;

  if (id === undefined) throw new Error(`Template ${entry.id} was not written.`);

  return { id, created: true };
}

export async function importTemplates(
  deps: TemplateImportDeps,
  input: ImportTemplatesInput,
): Promise<TemplateImportReport> {
  const source = input.artefactPath ?? defaultArtefactPath();
  const raw = readArtefact(source);

  if (!Array.isArray(raw)) {
    throw new Error(`The corpus artefact at ${source} is not an array of templates.`);
  }

  const outcomes = raw.map(accept);

  const candidates = outcomes.filter((outcome): outcome is Candidate => !isRejection(outcome));
  const rejected = outcomes
    .filter(isRejection)
    .map(({ id, name, reason }) => ({ id, name, reason }));

  // Duplicate ids inside one artefact would silently make the second entry look like a
  // re-import of the first. The corpus cannot produce this; a hand-edited file can.
  const seen = new Set<string>();
  const unique: Candidate[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.entry.id)) {
      rejected.push({
        id: candidate.entry.id,
        name: candidate.entry.name,
        reason: 'duplicate id within the artefact',
      });
      continue;
    }

    seen.add(candidate.entry.id);
    unique.push(candidate);
  }

  const byProvenance = countBy(unique.map((candidate) => candidate.entry.provenance));

  if (input.dryRun === true) {
    const { created, existing, newVersions, unchanged } = await withTenant(
      deps.pool,
      { orgId: input.orgId },
      async (tx) => countDryRun(tx, input.orgId, unique),
    );

    return {
      source,
      entries: raw.length,
      templates_created: created,
      templates_existing: existing,
      versions_created: newVersions,
      versions_unchanged: unchanged,
      rejected,
      by_provenance: byProvenance,
      dry_run: true,
    };
  }

  // One transaction for the write: the artefact is the unit of import, so a database
  // error half-way must leave no templates behind. Validation failures are already out
  // of the picture — they never reach a write.
  return withTenant(
    deps.pool,
    { orgId: input.orgId, actorId: input.actorId ?? null },
    async (tx) => {
      let templatesCreated = 0;
      let templatesExisting = 0;
      let versionsCreated = 0;
      let versionsUnchanged = 0;

      // Read the tenant's existing state once, not twice per template. At 427 templates the
      // per-entry version of this was ~1,700 round-trips and took long enough to matter to
      // whoever runs it; the whole point of an import is that it is cheap to re-run.
      const known = await loadTenantState(tx, input.orgId);
      const templates = new Map(known.templates);

      for (const candidate of unique) {
        const { entry } = candidate;
        const template = await upsertTemplate(tx, input.orgId, candidate, templates);

        if (template.created) {
          templatesCreated += 1;
          templates.set(entry.id, template.id);
        } else {
          templatesExisting += 1;
        }

        if (known.versions.has(`${template.id}:${candidate.digest}`)) {
          versionsUnchanged += 1;
          continue;
        }

        const next = (known.maxVersion.get(template.id) ?? 0) + 1;

        await tx.query(
          `insert into template_version
           (org_id, template_id, version, body, token_stream, fields, content_hash, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            // 0002 made the version carry its own tenant, because a policy is per table and
            // a version body is the clinical wording a signed report is pinned to.
            input.orgId,
            template.id,
            next,
            candidate.body,
            JSON.stringify({ schema_version: TOKEN_SCHEMA_VERSION, tokens: entry.tokens }),
            JSON.stringify(entry.fields),
            candidate.digest,
            input.actorId ?? null,
          ],
        );

        // Keep the in-memory view current, so a second entry for the same template inside
        // one artefact gets version 2 rather than colliding with version 1.
        known.versions.add(`${template.id}:${candidate.digest}`);
        known.maxVersion.set(template.id, next);

        versionsCreated += 1;
      }

      return {
        source,
        entries: raw.length,
        templates_created: templatesCreated,
        templates_existing: templatesExisting,
        versions_created: versionsCreated,
        versions_unchanged: versionsUnchanged,
        rejected,
        by_provenance: byProvenance,
        dry_run: false,
      };
    },
  );
}

async function countDryRun(
  tx: Tx,
  orgId: string,
  candidates: readonly Candidate[],
): Promise<{ created: number; existing: number; newVersions: number; unchanged: number }> {
  let created = 0;
  let existing = 0;
  let newVersions = 0;
  let unchanged = 0;

  // Same view as the real run, built the same way, so a dry run cannot disagree with what
  // the import would actually do.
  const known = await loadTenantState(tx, orgId);

  for (const candidate of candidates) {
    const template = known.templates.get(candidate.entry.id);

    if (template === undefined) {
      created += 1;
      newVersions += 1;
      continue;
    }

    existing += 1;

    if (known.versions.has(`${template}:${candidate.digest}`)) unchanged += 1;
    else newVersions += 1;
  }

  return { created, existing, newVersions, unchanged };
}
