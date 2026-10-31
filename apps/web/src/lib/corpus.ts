import fs from 'node:fs';
import path from 'node:path';

import type { Token } from '@reporting/tokens';

/**
 * The template library, read from the committed corpus artefact.
 *
 * The artefact is produced by `pnpm corpus` from the immutable source under
 * `alem-reporting-templates/` (ADR-0004). This module reads it; it never imports the
 * importer, never re-parses a template body, and never repairs anything. If the
 * artefact is missing or malformed the process fails to start with a message that
 * names the path — a server that boots with an empty library is worse than one that
 * refuses to boot, because the failure surfaces as "no templates found" in a clinical
 * setting.
 *
 * This file is server-only. Filesystem access in a client component would be a build
 * error rather than a silent empty list, but the rule is kept by naming and by the
 * fact that nothing under `src/components` imports it.
 */

export interface TemplateField {
  readonly key: string;
  readonly ordinal: number;
  readonly placeholder: string;
  readonly label: string;
  readonly section: string | null;
  readonly type: string;
}

export interface TemplateRecord {
  readonly id: string;
  readonly name: string;
  readonly base_name: string;
  readonly variant_label: string;
  readonly scope: string;
  readonly modality: readonly string[];
  readonly type: string;
  readonly status: string;
  readonly provenance: string;
  readonly sections: readonly string[];
  readonly fields: readonly TemplateField[];
  readonly tokens: readonly Token[];
  readonly char_count: number;
}

export interface Library {
  readonly templates: readonly TemplateRecord[];
  readonly byId: ReadonlyMap<string, TemplateRecord>;
  /** Where the data came from, shown on the health endpoint so a bad mount is visible. */
  readonly source: string;
}

const TOKEN_KINDS = new Set(['text', 'heading', 'field']);

/**
 * Resolved from the working directory because Next builds and runs from `apps/web`,
 * while the artefact belongs to the repository root. An explicit override exists for
 * the container image, where the corpus is copied to a path of its own choosing.
 */
export function corpusPath(): string {
  const configured = process.env['CORPUS_PATH'];
  return configured === undefined || configured === ''
    ? path.resolve(process.cwd(), '../../corpus/generated/templates.json')
    : path.resolve(configured);
}

function fail(source: string, detail: string): never {
  throw new Error(
    `Template library could not be loaded from ${source}: ${detail}. ` +
      'Run `pnpm corpus` to regenerate the artefact, or set CORPUS_PATH.',
  );
}

function asString(value: unknown, field: string, index: number): string {
  if (typeof value !== 'string') throw new Error(`entry ${index}: "${field}" is not a string`);
  return value;
}

/**
 * Structural validation, deliberately shallow: it checks the shape this module
 * depends on and lets the type system carry the rest. Deep validation of token
 * streams belongs to the importer that produced them.
 */
function parseTemplate(value: unknown, index: number): TemplateRecord {
  if (typeof value !== 'object' || value === null) throw new Error(`entry ${index}: not an object`);

  const raw = value as Record<string, unknown>;

  if (!Array.isArray(raw['tokens'])) throw new Error(`entry ${index}: "tokens" is not an array`);

  const tokens: Token[] = [];
  for (const [tokenIndex, token] of raw['tokens'].entries()) {
    if (typeof token !== 'object' || token === null) {
      throw new Error(`entry ${index}: token ${tokenIndex} is not an object`);
    }
    const kind = (token as Record<string, unknown>)['kind'];
    if (typeof kind !== 'string' || !TOKEN_KINDS.has(kind)) {
      // A token kind this renderer does not know is a schema version it does not
      // understand. Dropping it would silently delete clinical wording from the page.
      throw new Error(`entry ${index}: token ${tokenIndex} has unknown kind ${String(kind)}`);
    }
    tokens.push(token as Token);
  }

  const modality = raw['modality'];
  if (!Array.isArray(modality) || modality.some((item) => typeof item !== 'string')) {
    throw new Error(`entry ${index}: "modality" is not a string array`);
  }

  const sections = raw['sections'];
  const fields = raw['fields'];
  if (!Array.isArray(sections)) throw new Error(`entry ${index}: "sections" is not an array`);
  if (!Array.isArray(fields)) throw new Error(`entry ${index}: "fields" is not an array`);

  return {
    id: asString(raw['id'], 'id', index),
    name: asString(raw['name'], 'name', index),
    base_name: asString(raw['base_name'], 'base_name', index),
    variant_label: asString(raw['variant_label'], 'variant_label', index),
    scope: asString(raw['scope'], 'scope', index),
    modality: modality as string[],
    type: asString(raw['type'], 'type', index),
    status: asString(raw['status'], 'status', index),
    provenance: asString(raw['provenance'], 'provenance', index),
    sections: sections as string[],
    fields: fields as TemplateField[],
    tokens,
    char_count: typeof raw['char_count'] === 'number' ? raw['char_count'] : 0,
  };
}

function readLibrary(): Library {
  const source = corpusPath();

  let text: string;
  try {
    text = fs.readFileSync(source, 'utf8');
  } catch (error) {
    fail(source, error instanceof Error ? error.message : 'unreadable');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(source, `not valid JSON (${error instanceof Error ? error.message : 'parse error'})`);
  }

  if (!Array.isArray(parsed)) fail(source, 'expected an array of templates');

  const templates = parsed.map((value, index) => {
    try {
      return parseTemplate(value, index);
    } catch (error) {
      fail(source, error instanceof Error ? error.message : 'invalid entry');
    }
  });

  // Sorted once here so search, pagination and the facet lists cannot disagree about
  // order, and so paging is stable without a tie-breaker at every call site.
  const sorted = [...templates].sort(
    (a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id, 'en'),
  );

  return {
    templates: sorted,
    byId: new Map(sorted.map((template) => [template.id, template])),
    source,
  };
}

/**
 * Cached per process. The artefact is ~1.9 MB and immutable for the life of a
 * release, so parsing it once is the difference between a 40 ms and a 4 ms page.
 * A hot reload in development creates a new module instance, which re-reads.
 */
let cached: Library | undefined;

export function getLibrary(): Library {
  cached ??= readLibrary();
  return cached;
}
