import Link from 'next/link';

import type { TemplateRecord } from '@/lib/corpus';
import { facetLabel } from '@/lib/search';

/**
 * One template in the results list.
 *
 * The attributes are a description list rather than a run of chips: "Modality CT" is
 * announced as a term and a definition, which is what it is. Provenance is shown
 * because a clinician choosing a template should be able to see whether it was authored
 * in-house — and because the licensing position (risk R1) is unresolved.
 */
export function TemplateCard({ template }: { readonly template: TemplateRecord }) {
  const variant =
    template.variant_label !== '' && template.variant_label !== template.base_name
      ? template.variant_label
      : null;

  return (
    <article className="rounded border border-line bg-surface-raised p-4">
      <h3 className="text-base font-semibold">
        <Link
          className="text-accent underline hover:text-accent-hover"
          href={`/templates/${template.id}`}
        >
          {template.name}
        </Link>
      </h3>

      {variant === null ? null : <p className="mt-1 text-sm text-ink-muted">Variant: {variant}</p>}

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-ink-muted">Modality</dt>
          <dd>{template.modality.join(', ')}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Type</dt>
          <dd>{template.type === 'STRUCTURED' ? 'Structured' : 'Free text'}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Fields</dt>
          <dd className="tabular-nums">{template.fields.length}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Provenance</dt>
          <dd>{facetLabel('provenance', template.provenance)}</dd>
        </div>
      </dl>
    </article>
  );
}
