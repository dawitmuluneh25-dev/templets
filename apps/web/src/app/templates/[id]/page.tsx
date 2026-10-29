import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getLibrary } from '@/lib/corpus';
import { outline, toDocumentNodes, type DocumentNode } from '@/lib/render';
import { facetLabel } from '@/lib/search';

interface PageProps {
  readonly params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const template = getLibrary().byId.get(id);

  return { title: template?.name ?? 'Template not found' };
}

function Node({ node, index }: { readonly node: DocumentNode; readonly index: number }) {
  switch (node.kind) {
    case 'heading':
      return node.level === 1 ? (
        <h2
          id={`section-${index}`}
          className="mt-6 mb-1 text-xs font-semibold tracking-widest text-ink-muted uppercase"
        >
          {node.text}
        </h2>
      ) : (
        <h3 className="mt-4 mb-1 text-sm font-semibold">{node.text}</h3>
      );
    case 'text':
      // pre-wrap, not paragraph splitting: the newlines are the template's layout and
      // reflowing them would change the wording a signature will attest (ADR-0005).
      return <span className="whitespace-pre-wrap">{node.value}</span>;
    case 'field':
      return (
        <span
          className="mx-0.5 inline-block rounded-sm border-b-2 border-dashed border-line-strong bg-surface-muted px-1 text-[0.9em] text-ink-muted"
          data-field-key={node.key}
        >
          {node.placeholder}
        </span>
      );
  }
}

export default async function TemplatePage({ params }: PageProps) {
  const { id } = await params;
  const template = getLibrary().byId.get(id);

  if (template === undefined) notFound();

  const nodes = toDocumentNodes(template.tokens);
  const sections = outline(nodes);

  return (
    <>
      <p className="no-print text-sm">
        <Link className="text-accent underline hover:text-accent-hover" href="/">
          ← Template library
        </Link>
      </p>

      <h1 className="mt-3 text-2xl font-semibold tracking-tight">{template.name}</h1>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 border-y border-line py-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-muted">Modality</dt>
          <dd>{template.modality.join(', ')}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Type</dt>
          <dd>{template.type === 'STRUCTURED' ? 'Structured' : 'Free text'}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Scope</dt>
          <dd>{template.scope}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Provenance</dt>
          <dd>{facetLabel('provenance', template.provenance)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Fields</dt>
          <dd className="tabular-nums">{template.fields.length}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Status</dt>
          <dd>{template.status}</dd>
        </div>
      </dl>

      <div className="mt-6 grid gap-8 lg:grid-cols-[14rem_minmax(0,1fr)]">
        {sections.length === 0 ? null : (
          <nav aria-label="Sections" className="no-print lg:sticky lg:top-4 lg:self-start">
            <h2 className="mb-2 text-xs font-semibold tracking-wide text-ink-muted uppercase">
              Sections
            </h2>
            <ol className="space-y-1 text-sm">
              {nodes.map((node, index) =>
                node.kind === 'heading' && node.level === 1 ? (
                  <li key={`${node.text}-${index}`}>
                    <a
                      className="text-accent underline hover:text-accent-hover"
                      href={`#section-${index}`}
                    >
                      {node.text}
                    </a>
                  </li>
                ) : null,
              )}
            </ol>
          </nav>
        )}

        <article
          aria-label={`${template.name} body`}
          className="max-w-prose text-[0.95rem] leading-relaxed"
        >
          {nodes.map((node, index) => (
            <Node key={`${node.kind}-${index}`} node={node} index={index} />
          ))}
        </article>
      </div>

      <p className="no-print mt-8 max-w-prose rounded border border-line bg-surface-muted p-4 text-sm text-ink-muted">
        Read-only preview. Authoring lands with the editor island (P2); signing needs the identity
        provider (E9), so nothing here can be completed or signed yet.
      </p>
    </>
  );
}
