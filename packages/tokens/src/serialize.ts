import type { Token } from './types.js';

/**
 * Exact reconstruction of the source body.
 *
 * The invariant this must satisfy: `serialize(parse(body)) === body`, byte for
 * byte, for all 427 corpus files. Heading markers are included because they are
 * template content; field tokens emit `raw` so the brackets survive unfilled.
 */
export function serialize(tokens: readonly Token[]): string {
  let out = '';

  for (const token of tokens) {
    switch (token.kind) {
      case 'text':
        out += token.value;
        break;
      case 'heading':
        out += token.marker + token.text;
        break;
      case 'field':
        out += token.raw;
        break;
    }
  }

  return out;
}

export interface RenderOptions {
  /** Field values by key. A field with no value falls back to its placeholder. */
  readonly fieldValues?: Readonly<Record<string, string>>;
  /** When false, unfilled fields render as nothing. Defaults to true. */
  readonly includeUnfilled?: boolean;
}

/**
 * Renders tokens for display — the same tree, with field values substituted.
 *
 * This is a renderer over the AST, not a parser: it never inspects text to
 * recover structure, which is what keeps text, HTML, PDF and FHIR output in
 * agreement (ADR-0005).
 */
export function render(tokens: readonly Token[], options: RenderOptions = {}): string {
  const { fieldValues = {}, includeUnfilled = true } = options;
  let out = '';

  for (const token of tokens) {
    switch (token.kind) {
      case 'text':
        out += token.value;
        break;
      case 'heading':
        out += token.marker + token.text;
        break;
      case 'field': {
        const value = fieldValues[token.key];
        if (value !== undefined && value !== '') out += value;
        else if (includeUnfilled) out += token.raw;
        break;
      }
    }
  }

  return out;
}
