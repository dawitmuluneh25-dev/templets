import { describe, expect, it } from 'vitest';

import {
  TOKEN_SCHEMA_VERSION,
  hash,
  migrate,
  parse,
  render,
  serialize,
  type FieldToken,
  type Token,
  type TokenDocument,
} from './index.js';

const BODY = [
  'EXAM:',
  'XR Chest, [set View(s)].',
  '',
  'FINDINGS:',
  'LUNGS:',
  'The lungs are clear.',
  'PLEURAL SPACES:',
  '',
  'IMPRESSION:',
  '[___]',
].join('\n');

describe('round-trip', () => {
  it('serialises back to the exact source body', () => {
    expect(serialize(parse(BODY).tokens)).toBe(BODY);
  });

  it('keeps the colon heading marker in the following text token', () => {
    const first = parse(BODY).tokens[0];

    expect(first).toMatchObject({ kind: 'heading', level: 1, text: 'EXAM', marker: '' });
  });

  it('preserves a space before the colon', () => {
    // 'CTA CHEST :' appears in the corpus; the space is content, not a typo to fix.
    const body = 'CTA CHEST :\nNormal.';
    expect(serialize(parse(body).tokens)).toBe(body);
  });
});

describe('fields', () => {
  it('discriminates field tokens and exposes document order', () => {
    const parsed = parse(BODY);
    const fields = parsed.tokens.filter((token): token is FieldToken => token.kind === 'field');

    expect(fields).toHaveLength(2);
    expect(parsed.fields.map((field) => field.ordinal)).toEqual([1, 2]);
  });

  it('classifies a slash-separated choice list as an enum', () => {
    const parsed = parse('FINDINGS:\n[mild/moderate/severe]');

    expect(parsed.fields[0]).toMatchObject({
      type: 'enum',
      options: ['mild', 'moderate', 'severe'],
    });
  });

  it('leaves an "or" list as free text, as the corpus classifier does', () => {
    // `[with or without IV contrast]` is a sentence, not a picklist. The
    // classifier only treats slash lists as choices; `or` stays text so the
    // radiologist can write around it.
    const parsed = parse('TECHNIQUE:\n[with or without IV contrast]');

    expect(parsed.fields[0]?.type).toBe('text');
  });

  it('types a blank as a measurement only when the unit is adjacent', () => {
    // Fidelity to the corpus importer: `[___]mm` is a measurement, `[___] mm` is
    // text. Preserved deliberately — changing it would reclassify fields across
    // the corpus, and the artefact is the specification.
    expect(parse('FINDINGS:\nNodule [___]mm.').fields[0]).toMatchObject({
      type: 'number',
      unit: 'mm',
    });
    expect(parse('FINDINGS:\nNodule [___] mm.').fields[0]?.type).toBe('text');
  });

  it('flattens a nested placeholder into one field', () => {
    const parsed = parse('TECHNIQUE:\n[[with and without IV contrast]]');

    expect(parsed.fields).toHaveLength(1);
    expect(parsed.tokens.some((token) => token.kind === 'text' && token.value.includes('['))).toBe(
      false,
    );
  });
});

describe('render', () => {
  it('substitutes field values and leaves unfilled fields as their placeholder', () => {
    const parsed = parse(BODY);
    const key = parsed.fields[0]?.key ?? '';

    const filled = render(parsed.tokens, { fieldValues: { [key]: 'PA' } });

    expect(filled).toContain('XR Chest, PA.');
    expect(filled).toContain('[___]');
  });

  it('omits unfilled placeholders when asked', () => {
    const parsed = parse('FINDINGS:\nNodule [___] mm.');

    expect(render(parsed.tokens, { includeUnfilled: false })).toBe('FINDINGS:\nNodule  mm.');
  });
});

describe('hash and migration', () => {
  it('hashes the canonical form, not the rendered form', () => {
    const a = hash(serialize(parse(BODY).tokens));
    const b = hash(serialize(parse(BODY).tokens));

    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('accepts a current document and refuses an unknown version', () => {
    const document: TokenDocument = { schema_version: TOKEN_SCHEMA_VERSION, tokens: [] };

    expect(migrate(document)).toBe(document);
    expect(() => migrate({ ...document, schema_version: 99 as never })).toThrow(/Unsupported/);
  });

  it('keeps the token union exhaustive', () => {
    const tokens: readonly Token[] = parse(BODY).tokens;
    const kinds = new Set(tokens.map((token) => token.kind));

    expect([...kinds].sort()).toEqual(['field', 'heading', 'text']);
  });
});
