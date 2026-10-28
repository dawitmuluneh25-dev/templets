import { describe, expect, it } from 'vitest';

import { TOKEN_SCHEMA_VERSION, type FieldToken, type Token, type TokenDocument } from './index.js';

describe('token model', () => {
  it('pins the schema version', () => {
    expect(TOKEN_SCHEMA_VERSION).toBe(1);
  });

  it('discriminates field tokens from text tokens', () => {
    const tokens: readonly Token[] = [
      { kind: 'text', value: 'LUNGS:' },
      { kind: 'break', strength: 'paragraph' },
      { kind: 'field', key: 'lungs_findings', placeholder: 'set View(s).' },
    ];

    const fields = tokens.filter((token): token is FieldToken => token.kind === 'field');

    expect(fields).toHaveLength(1);
    expect(fields.map((field) => field.key)).toEqual(['lungs_findings']);
  });

  it('rejects a document with an unpinned schema version', () => {
    // @ts-expect-error — a document without a schema version is not a document.
    const invalid: TokenDocument = { tokens: [] };

    expect(invalid.schema_version).toBeUndefined();
  });
});
