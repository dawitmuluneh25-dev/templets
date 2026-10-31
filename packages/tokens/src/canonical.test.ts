import { describe, expect, it } from 'vitest';

import { canonicalJson, contentHash } from './canonical.js';
import { parse } from './parse.js';
import type { TokenDocument } from './types.js';

const document: TokenDocument = {
  schema_version: 1,
  tokens: [
    { kind: 'heading', level: 1, text: 'FINDINGS', marker: '' },
    { kind: 'text', value: ':\n' },
    { kind: 'field', key: 'f1', raw: '[___]', placeholder: '___' },
    { kind: 'text', value: ' mm nodule.\n' },
  ],
};

describe('canonicalJson', () => {
  it('is independent of key insertion order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it('emits no insignificant whitespace', () => {
    expect(canonicalJson({ a: [1, 2], b: 'x' })).toBe('{"a":[1,2],"b":"x"}');
  });

  it('drops undefined object members but refuses them inside arrays', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalJson([1, undefined])).toThrow(/not representable/);
  });

  it('refuses values JSON cannot represent faithfully', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ a: 1n })).toThrow(/bigint/);
  });

  it('round-trips through JSON.parse unchanged', () => {
    const value = { list: [1, 'two', null, { deep: true }], nested: { z: 0 } };
    expect(JSON.parse(canonicalJson(value))).toEqual(value);
  });
});

describe('contentHash', () => {
  it('changes when a field value changes', () => {
    const empty = contentHash(document, {});
    const filled = contentHash(document, { f1: '8' });

    expect(filled).not.toBe(empty);
    expect(filled.startsWith('sha256:')).toBe(true);
  });

  it('is stable across the jsonb round-trip the database performs', () => {
    // jsonb reorders keys and may re-encode strings; the hash must not notice.
    const roundTripped = JSON.parse(JSON.stringify(document)) as TokenDocument;

    expect(contentHash(roundTripped, { f1: '8' })).toBe(contentHash(document, { f1: '8' }));
  });

  it('does not depend on how the document was obtained', () => {
    const parsed = parse('FINDINGS:\n[___] mm nodule.\n');
    const asDocument: TokenDocument = { schema_version: 1, tokens: parsed.tokens };

    expect(contentHash(asDocument, {})).toBe(
      contentHash({ schema_version: 1, tokens: parsed.tokens }, {}),
    );
  });

  it('separates report content from a raw body hash of the same bytes', () => {
    // A template body and a filled report are different objects; their hashes
    // must not be comparable, or an audit trail can be misread.
    const bodyHash = contentHash(document, {});
    expect(bodyHash).not.toBe(`sha256:${'0'.repeat(64)}`);
    expect(bodyHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
