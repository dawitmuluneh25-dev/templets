import type { Token } from '@reporting/tokens';

/**
 * Token stream → the nodes the page renders.
 *
 * The projection is deliberately lossless with respect to *text*: a text token keeps
 * its exact value, newlines included, and is rendered with `white-space: pre-wrap`
 * rather than being split into paragraphs. Reflowing clinical text to make it prettier
 * is how a template's wording stops matching the corpus the signature attests
 * (ADR-0004/ADR-0005).
 *
 * An unknown token kind is an error, not a skipped node: it means the artefact was
 * produced by a schema version this renderer does not understand, and silently dropping
 * it would delete clinical wording from the page.
 */

export type DocumentNode =
  | { readonly kind: 'heading'; readonly level: 1 | 2; readonly text: string }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'field'; readonly key: string; readonly placeholder: string };

export function toDocumentNodes(tokens: readonly Token[]): readonly DocumentNode[] {
  return tokens.map((token) => toNode(token));
}

function toNode(token: Token): DocumentNode {
  switch (token.kind) {
    case 'heading':
      return { kind: 'heading', level: token.level, text: token.text };
    case 'text':
      return { kind: 'text', value: token.value };
    case 'field':
      return { kind: 'field', key: token.key, placeholder: token.placeholder };
    default: {
      const unhandled: never = token;
      throw new Error(`Unhandled token kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Section headings in document order — the basis of the in-page outline. */
export function outline(nodes: readonly DocumentNode[]): readonly string[] {
  return nodes.flatMap((node) => (node.kind === 'heading' && node.level === 1 ? [node.text] : []));
}
