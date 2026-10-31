/**
 * Public surface of the serialisation boundary (ADR-0005).
 *
 * Import from `@reporting/tokens` only. Reaching into `src/*` is a lint error —
 * two serialisers eventually disagree, and a signature computed by the wrong one
 * is evidence that says something untrue.
 */
export {
  TOKEN_SCHEMA_VERSION,
  type FieldDescriptor,
  type FieldToken,
  type FieldType,
  type HeadingToken,
  type ParsedBody,
  type TextToken,
  type Token,
  type TokenDocument,
  type TokenSchemaVersion,
} from './types.js';

export { parse } from './parse.js';
export { render, serialize, type RenderOptions } from './serialize.js';
export { hash } from './hash.js';
export { canonicalJson, contentHash } from './canonical.js';
export { migrate } from './migrate.js';
