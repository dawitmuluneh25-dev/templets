import type { FacetKey, FacetOption, LibraryFilters } from '@/lib/search';
import { libraryHref, withFacet } from '@/lib/search';

interface FacetGroupProps {
  readonly facetKey: FacetKey;
  readonly title: string;
  readonly options: readonly FacetOption[];
  readonly filters: LibraryFilters;
}

/**
 * One facet as a list of links.
 *
 * Links, not checkboxes, because the filter state lives in the URL: every view is
 * bookmarkable, the back button behaves, and the whole page works with JavaScript
 * disabled — which matters on a locked-down hospital desktop more than it sounds.
 *
 * The count is inside the link text rather than in an aria-label, so a screen reader
 * reads "CT 112" the same way a sighted user reads it.
 */
export function FacetGroup({ facetKey, title, options, filters }: FacetGroupProps) {
  if (options.length === 0) return null;

  const headingId = `facet-${facetKey}`;

  return (
    <section
      className="border-t border-line pt-3 first:border-t-0 first:pt-0"
      aria-labelledby={headingId}
    >
      <h3
        id={headingId}
        className="mb-2 text-xs font-semibold tracking-wide text-ink-muted uppercase"
      >
        {title}
      </h3>
      <ul className="space-y-1">
        {options.map((option) => {
          const selected = option.selected;

          return (
            <li key={option.value}>
              <a
                href={libraryHref(withFacet(filters, facetKey, option.value))}
                aria-current={selected ? 'true' : undefined}
                className={[
                  'flex items-baseline justify-between gap-2 rounded px-2 py-1 text-sm',
                  selected
                    ? 'bg-surface-muted font-semibold text-ink'
                    : 'text-accent underline hover:bg-surface-muted hover:text-accent-hover',
                ].join(' ')}
              >
                <span>{option.label}</span>
                <span className="text-xs text-ink-muted tabular-nums">{option.count}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
