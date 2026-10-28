/**
 * The serialisation boundary (ADR-0005).
 *
 * Nothing here is implemented yet. What exists is the shape the rest of the
 * workspace compiles against, so that the boundary is a type before it is code.
 * `parse`, `serialize`, `render`, `hash` and `migrate` land in P1 step 6, with
 * the 427-template fixture corpus as their test input.
 *
 * The stored document is the canonical token stream. The ProseMirror document
 * is a view rebuilt from it and is never persisted.
 */

/** Bumped only with a migration and fixtures captured at the previous version. */
export const TOKEN_SCHEMA_VERSION = 1 as const;

export type TokenSchemaVersion = typeof TOKEN_SCHEMA_VERSION;

/** Literal text a radiologist typed or a template shipped. */
export interface TextToken {
  readonly kind: 'text';
  readonly value: string;
}

/**
 * A typed field reference: `key` is stable across versions of a template,
 * `placeholder` is what the template displayed before the field was filled.
 * Both are kept — the placeholder is part of the reader's expectation.
 */
export interface FieldToken {
  readonly kind: 'field';
  readonly key: string;
  readonly placeholder: string;
}

/** Structural break. Paragraph breaks separate findings; line breaks do not. */
export interface BreakToken {
  readonly kind: 'break';
  readonly strength: 'line' | 'paragraph';
}

export type Token = TextToken | FieldToken | BreakToken;

/** A token stream plus the section it belongs to. Order is the document. */
export interface TokenDocument {
  readonly schema_version: TokenSchemaVersion;
  readonly tokens: readonly Token[];
}
