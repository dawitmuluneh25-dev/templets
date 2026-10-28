/**
 * The serialisation boundary (ADR-0005).
 *
 * `parse`, `serialize`, `render`, `hash` and `migrate` live here and nowhere
 * else. Everything downstream consumes the typed AST; nothing downstream
 * reparses text.
 *
 * The stored form is `serialize(parse(body))`, which is asserted equal to
 * `body` for every file in the corpus. Heading markers are template content,
 * not decoration, so each heading token carries its exact marker.
 */

/** Bumped only with a migration and fixtures captured at the previous version. */
export const TOKEN_SCHEMA_VERSION = 1 as const;

export type TokenSchemaVersion = typeof TOKEN_SCHEMA_VERSION;

/** Literal text, exactly as it appears in the source body. */
export interface TextToken {
  readonly kind: 'text';
  readonly value: string;
}

/**
 * A section or sub-section heading.
 *
 * `marker` is what preceded the heading text in the source (`## `, or the empty
 * string for the `EXAM:` colon form). The colon form deliberately keeps its `:`
 * in the *following* text token — that is how the source is shaped, and moving
 * it would change the bytes.
 */
export interface HeadingToken {
  readonly kind: 'heading';
  readonly level: 1 | 2;
  readonly text: string;
  readonly marker: string;
}

/** A typed field reference. `raw` is the exact source text, brackets included. */
export interface FieldToken {
  readonly kind: 'field';
  readonly key: string;
  readonly raw: string;
  readonly placeholder: string;
}

export type Token = TextToken | HeadingToken | FieldToken;

/** Field kinds the corpus actually supports. Deterministic rules, no inference. */
export type FieldType = 'text' | 'number' | 'enum' | 'multislot' | 'dateOrNone';

export interface FieldDescriptor {
  readonly key: string;
  /** 1-based position in document order. */
  readonly ordinal: number;
  readonly placeholder: string;
  readonly raw: string;
  readonly type: FieldType;
  /** Operator-facing hint, e.g. `mild / moderate / severe`. */
  readonly label: string;
  /** Section the field sits in; `null` before the first heading. */
  readonly section: string | null;
  readonly options?: readonly string[];
  readonly unit?: string;
  readonly slotCount?: number;
}

export interface ParsedBody {
  readonly schema_version: TokenSchemaVersion;
  readonly template_type: string;
  readonly tokens: readonly Token[];
  readonly fields: readonly FieldDescriptor[];
  /** Level-1 headings, in document order. */
  readonly sections: readonly string[];
}

/** A document as stored: tokens plus the version that produced them. */
export interface TokenDocument {
  readonly schema_version: TokenSchemaVersion;
  readonly tokens: readonly Token[];
}
