import { describe, expect, it } from 'vitest';

import type { Token } from '@reporting/tokens';

import { outline, toDocumentNodes } from './render.js';

const tokens: readonly Token[] = [
  { kind: 'heading', level: 1, text: 'IMPRESSION', marker: '' },
  { kind: 'text', value: ':\nNo acute abnormality.\n' },
  { kind: 'field', key: 'impression__free', raw: '[free text]', placeholder: 'free text' },
];

describe('token projection', () => {
  it('maps each token kind to a render node', () => {
    expect(toDocumentNodes(tokens)).toEqual([
      { kind: 'heading', level: 1, text: 'IMPRESSION' },
      { kind: 'text', value: ':\nNo acute abnormality.\n' },
      { kind: 'field', key: 'impression__free', placeholder: 'free text' },
    ]);
  });

  it('keeps text byte-identical, newlines included', () => {
    // Reflowing clinical text is how a template stops matching the corpus the
    // signature attests, so this is the assertion that protects the wording.
    const value = ':\nLine one.\n\nLine three.  \n';
    const [node] = toDocumentNodes([{ kind: 'text', value }]);

    expect(node).toEqual({ kind: 'text', value });
  });

  it('refuses a token kind it does not understand', () => {
    const alien = { kind: 'table', rows: [] } as unknown as Token;

    expect(() => toDocumentNodes([alien])).toThrow(/Unhandled token kind/);
  });

  it('collects level-1 headings for the outline, in order', () => {
    const nodes = toDocumentNodes([
      { kind: 'heading', level: 1, text: 'FINDINGS', marker: '' },
      { kind: 'heading', level: 2, text: 'Lungs', marker: '## ' },
      { kind: 'text', value: 'clear' },
      { kind: 'heading', level: 1, text: 'IMPRESSION', marker: '' },
    ]);

    expect(outline(nodes)).toEqual(['FINDINGS', 'IMPRESSION']);
  });
});
