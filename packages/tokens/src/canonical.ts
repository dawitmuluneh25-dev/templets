import { hash } from './hash.js';
import type { TokenDocument } from './types.js';

/**
 * Canonical JSON — the byte form every evidence hash is computed over.
 *
 * Two properties are load-bearing:
 *
 * 1. **Key order is fixed** (sorted by code unit), so a value that was built by a
 *    different code path, or round-tripped through `jsonb`, hashes identically.
 *    `jsonb` reorders keys; a hash over an unordered object would be a hash over
 *    a serialisation accident.
 * 2. **No insignificant whitespace**, so a formatter, a pretty-printer or a
 *    `JSON.stringify(x, null, 2)` in a debug branch cannot change what a
 *    signature appears to attest.
 *
 * `undefined` is dropped from objects (it has no JSON form) and rejected inside
 * arrays, because silently turning it into `null` is how two genuinely different
 * documents end up with the same hash.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, '$');
}

function encode(value: unknown, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      }
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: ${typeof value} is not representable at ${path}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item, index) => encode(item, `${path}[${index}]`)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const body = entries
    .map(([key, item]) => `${JSON.stringify(key)}:${encode(item, `${path}.${key}`)}`)
    .join(',');

  return `{${body}}`;
}

/**
 * Domain separation for report content hashes.
 *
 * Without it, a template body hash and a filled-report hash are both
 * `sha256(canonical json)` and could in principle be compared to each other —
 * which is exactly the class of bug that makes an audit trail say something
 * true but about the wrong object.
 */
const CONTENT_HASH_PREFIX = 'report-content/v1\n';

/**
 * The hash a signature attests.
 *
 * Computed over the stored tree and the field values — **not** over rendered
 * output. A renderer is allowed to improve (a spacing fix, a new PDF engine);
 * if the hash were taken over the render, every such fix would silently change
 * what a past signature appears to testify to, which is the failure ADR-0005
 * exists to prevent. `render` is for humans; this is for evidence.
 */
export function contentHash(
  document: TokenDocument,
  fieldValues: Readonly<Record<string, string>> = {},
): string {
  return hash(
    CONTENT_HASH_PREFIX +
      canonicalJson({
        schema_version: document.schema_version,
        tokens: document.tokens,
        field_values: fieldValues,
      }),
  );
}
