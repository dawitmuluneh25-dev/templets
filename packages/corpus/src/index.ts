/**
 * The corpus importer.
 *
 * It does three things, in this order, and fails loudly at each:
 *
 * 1. **Inventory.** Every file the manifest names is present, and its byte count
 *    matches what the export recorded. A corpus that silently changed is worse
 *    than a corpus that will not import.
 * 2. **Round-trip.** `serialize(parse(body)) === body` for every file. Failure
 *    is quarantine, never repair — a parser that "fixes" a sentence has altered
 *    clinical wording (ADR-0004).
 * 3. **Provenance.** Each file is classified from its author metadata, not from
 *    the scope label it was filed under. Default deny.
 *
 * Output is deterministic: sorted, no timestamps, no absolute paths. That is
 * what lets CI regenerate it and assert the committed artefacts are unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  classifyProvenance,
  type ProvenanceClass,
  type TemplateManifestEntry,
} from '@reporting/template-schema';
import {
  TOKEN_SCHEMA_VERSION,
  parse,
  serialize,
  type FieldDescriptor,
  type Token,
} from '@reporting/tokens';

import { defaultSourceDir, listTemplateFiles, readTemplate, sha256 } from './read.js';

export interface QuarantineRecord {
  readonly relpath: string;
  readonly reason: 'missing' | 'byte_mismatch' | 'round_trip_mismatch' | 'no_divider';
  readonly detail: string;
}

export interface ProvenanceRecord {
  readonly relpath: string;
  readonly name: string;
  readonly scope: string;
  readonly modality: string;
  readonly type: string;
  readonly status: string;
  readonly author: string;
  readonly provenance: ProvenanceClass;
  readonly guid: string;
  /** Byte count of the file on disk. */
  readonly bytes: number;
  /** Byte count the export recorded for it. */
  readonly manifest_bytes: number;
  /** Hash of the raw file, before any cleaning. */
  readonly sha256: string;
  /** Hash of the body the round-trip is asserted against. */
  readonly body_sha256: string;
  readonly transforms: readonly string[];
}

export interface ImportedTemplate {
  readonly id: string;
  readonly name: string;
  readonly base_name: string;
  readonly variant_label: string | null;
  readonly scope: string;
  readonly modality: string;
  readonly type: string;
  readonly status: string;
  readonly provenance: ProvenanceClass;
  readonly guid: string;
  readonly schema_version: typeof TOKEN_SCHEMA_VERSION;
  readonly source_relpath: string;
  readonly char_count: number;
  readonly sections: readonly string[];
  readonly fields: readonly FieldDescriptor[];
  readonly tokens: readonly Token[];
}

export interface ImportStats {
  readonly files: number;
  readonly imported: number;
  readonly quarantined: number;
  readonly round_trip_pass: number;
  readonly round_trip_fail: number;
  readonly fields: number;
  readonly templates_with_fields: number;
  readonly residual_bracket_templates: number;
  readonly by_type: Readonly<Record<string, number>>;
  readonly by_modality: Readonly<Record<string, number>>;
  readonly by_scope: Readonly<Record<string, number>>;
  readonly by_provenance: Readonly<Record<string, number>>;
  readonly transformed: {
    readonly bom: number;
    readonly crlf: number;
    readonly escapes: number;
  };
}

export interface ImportResult {
  readonly stats: ImportStats;
  readonly provenance: readonly ProvenanceRecord[];
  readonly templates: readonly ImportedTemplate[];
  readonly quarantine: readonly QuarantineRecord[];
}

/** Deterministic key order, so the committed artefact is comparable by diff. */
function sortedCounts(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of [...values].sort()) counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}

function slug(value: string, fallback = 'template'): string {
  const out = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return out || fallback;
}

/** First point of divergence, for a quarantine record a human can act on. */
function firstDiff(actual: string, expected: string): string {
  const limit = Math.min(actual.length, expected.length);
  for (let i = 0; i < limit; i += 1) {
    if (actual.charAt(i) !== expected.charAt(i)) {
      const from = Math.max(0, i - 20);
      return (
        `at ${i}: got ${JSON.stringify(actual.slice(from, i + 20))} ` +
        `want ${JSON.stringify(expected.slice(from, i + 20))}`
      );
    }
  }
  return `length ${actual.length} vs ${expected.length}`;
}

interface VariantInfo {
  readonly displayName: string;
  readonly baseName: string;
  readonly variantLabel: string | null;
}

/**
 * The `.md` headers carry only the base template name; the variant relationship
 * lives in the export's index CSV (`XR Chest [variant: XR Chest]`). Read it so
 * 126 variant files group instead of appearing as duplicate cards.
 */
function readVariantIndex(sourceDir: string): Map<string, VariantInfo> {
  const map = new Map<string, VariantInfo>();
  const csvPath = path.join(sourceDir, 'templates_index.csv');
  if (!fs.existsSync(csvPath)) return map;

  const text = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inQuotes) {
      if (ch === '"' && text.charAt(i + 1) === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift() ?? [];
  const column = (name: string): number => header.findIndex((h) => h.trim() === name);

  const fileColumn = column('file_name');
  const displayColumn = column('site_display_name');
  if (fileColumn === -1 || displayColumn === -1) return map;

  for (const r of rows) {
    const file = r[fileColumn];
    if (file === undefined || file === '') continue;

    const display = r[displayColumn] ?? '';
    const variant = /^(.*?)\s*\[variant:\s*(.*?)\]$/.exec(display);

    map.set(file, {
      displayName: display,
      baseName: variant?.[1]?.trim() ?? display,
      variantLabel: variant?.[2]?.trim() ?? null,
    });
  }

  return map;
}

export interface ImportOptions {
  /** Defaults to the frozen export directory next to this workspace. */
  readonly sourceDir?: string;
}

export function importCorpus(options: ImportOptions = {}): ImportResult {
  const sourceDir = options.sourceDir ?? defaultSourceDir();
  const manifestPath = path.join(sourceDir, 'templates_manifest.json');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as TemplateManifestEntry[];
  const variants = readVariantIndex(sourceDir);

  const quarantine: QuarantineRecord[] = [];
  const provenance: ProvenanceRecord[] = [];
  const templates: ImportedTemplate[] = [];

  const byType: string[] = [];
  const byModality: string[] = [];
  const byScope: string[] = [];
  const byProvenance: string[] = [];

  let fields = 0;
  let templatesWithFields = 0;
  let residualBracketTemplates = 0;
  let roundTripPass = 0;
  let roundTripFail = 0;
  const transformed = { bom: 0, crlf: 0, escapes: 0 };

  // Inventory first: a manifest entry with no file is a broken export, not a
  // template to skip quietly.
  // Only the scope directories the manifest names are inventoried. The export
  // root also holds TEMPLATES_REPORT.md and the index CSV, which are corpus
  // documentation, not templates.
  const scopeDirs = [...new Set(manifest.map((entry) => entry.relpath.split('/')[0] ?? ''))]
    .filter((scope) => scope !== '')
    .sort();
  const onDisk = new Set(
    scopeDirs.flatMap((scope) => listTemplateFiles(path.join(sourceDir, scope), scope)),
  );
  for (const entry of manifest) {
    if (!onDisk.has(entry.relpath)) {
      quarantine.push({ relpath: entry.relpath, reason: 'missing', detail: 'not found on disk' });
    }
  }
  const claimed = new Set(manifest.map((entry) => entry.relpath));
  for (const relpath of onDisk) {
    if (!claimed.has(relpath)) {
      quarantine.push({ relpath, reason: 'missing', detail: 'on disk but absent from manifest' });
    }
  }

  const entries = [...manifest].sort((a, b) => a.relpath.localeCompare(b.relpath));

  for (const entry of entries) {
    const absolute = path.join(sourceDir, entry.relpath);
    if (!fs.existsSync(absolute)) continue; // already recorded above

    const raw = readTemplate(absolute);

    if (raw.flags.bom) transformed.bom += 1;
    if (raw.flags.crlf) transformed.crlf += 1;
    if (raw.flags.escapes) transformed.escapes += 1;

    if (raw.bytes !== entry.bytes) {
      quarantine.push({
        relpath: entry.relpath,
        reason: 'byte_mismatch',
        detail: `on disk ${raw.bytes}, manifest ${entry.bytes}`,
      });
      continue;
    }

    const parsed = parse(raw.body, entry.type);
    const roundTripped = serialize(parsed.tokens);

    if (roundTripped !== raw.body) {
      roundTripFail += 1;
      quarantine.push({
        relpath: entry.relpath,
        reason: 'round_trip_mismatch',
        detail: firstDiff(roundTripped, raw.body),
      });
      continue;
    }

    roundTripPass += 1;

    const provenanceClass = classifyProvenance({ author: entry.author });
    const variant = variants.get(path.basename(entry.relpath));

    byType.push(entry.type);
    byModality.push(entry.modality);
    byScope.push(entry.scope);
    byProvenance.push(provenanceClass);

    fields += parsed.fields.length;
    if (parsed.fields.length > 0) templatesWithFields += 1;
    if (parsed.tokens.some((token) => token.kind === 'text' && /\[[^\]\n]{1,80}\]/.test(token.value))) {
      residualBracketTemplates += 1;
    }

    const transforms: string[] = [];
    if (raw.flags.bom) transforms.push('bom');
    if (raw.flags.crlf) transforms.push('crlf');
    if (raw.flags.escapes) transforms.push('escapes');

    provenance.push({
      relpath: entry.relpath,
      name: entry.name,
      scope: entry.scope,
      modality: entry.modality,
      type: entry.type,
      status: entry.status,
      author: entry.author,
      provenance: provenanceClass,
      guid: entry.guid,
      bytes: raw.bytes,
      manifest_bytes: entry.bytes,
      sha256: raw.sha256,
      body_sha256: sha256(raw.body),
      transforms,
    });

    templates.push({
      id: `tpl_${entry.guid !== '' ? slug(entry.guid) : slug(entry.relpath)}`,
      name: variant?.displayName ?? entry.name,
      base_name: variant?.baseName ?? entry.name,
      variant_label: variant?.variantLabel ?? null,
      scope: entry.scope,
      modality: entry.modality,
      type: entry.type,
      status: entry.status,
      provenance: provenanceClass,
      guid: entry.guid,
      schema_version: TOKEN_SCHEMA_VERSION,
      source_relpath: entry.relpath,
      char_count: raw.body.length,
      sections: parsed.sections,
      fields: parsed.fields,
      tokens: parsed.tokens,
    });
  }

  quarantine.sort((a, b) => a.relpath.localeCompare(b.relpath));

  return {
    stats: {
      files: manifest.length,
      imported: templates.length,
      quarantined: quarantine.length,
      round_trip_pass: roundTripPass,
      round_trip_fail: roundTripFail,
      fields,
      templates_with_fields: templatesWithFields,
      residual_bracket_templates: residualBracketTemplates,
      by_type: sortedCounts(byType),
      by_modality: sortedCounts(byModality),
      by_scope: sortedCounts(byScope),
      by_provenance: sortedCounts(byProvenance),
      transformed,
    },
    provenance,
    templates,
    quarantine,
  };
}
