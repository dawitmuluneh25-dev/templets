import { migrate, type TokenDocument } from '@reporting/tokens';

/**
 * Reads a token document out of `jsonb` without trusting it.
 *
 * The database column is `jsonb`, so its type is `unknown` — a cast here would
 * let a malformed row (a half-applied importer, a hand-edited row, a future
 * schema) be hashed and signed as if it were a document. Hashing garbage produces
 * a perfectly valid signature over garbage, which is the worst possible outcome:
 * evidence that looks intact.
 *
 * So: check the two fields that define the shape, then hand it to `migrate`,
 * which either returns a document this build understands or throws.
 */
export function asTokenDocument(value: unknown, context: string): TokenDocument {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${context}: stored document is not an object`);
  }

  const candidate = value as { schema_version?: unknown; tokens?: unknown };

  if (typeof candidate.schema_version !== 'number') {
    throw new Error(`${context}: stored document has no numeric schema_version`);
  }

  if (!Array.isArray(candidate.tokens)) {
    throw new Error(`${context}: stored document has no token array`);
  }

  return migrate(candidate as TokenDocument);
}
