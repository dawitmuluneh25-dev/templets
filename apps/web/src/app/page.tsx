import type { Metadata } from 'next';

import { FacetGroup } from '@/components/facet-group';
import { Pagination } from '@/components/pagination';
import { TemplateCard } from '@/components/template-card';
import { getLibrary } from '@/lib/corpus';
import {
  FACET_KEYS,
  filtersFromParams,
  libraryHref,
  pageFromParams,
  queryLibrary,
  withoutFilters,
  type FacetKey,
  type SearchParams,
} from '@/lib/search';

export const metadata: Metadata = {
  title: 'Template library',
};

const FACET_TITLES: Readonly<Record<FacetKey, string>> = {
  modality: 'Modality',
  type: 'Template type',
  scope: 'Scope',
  provenance: 'Provenance',
};

export default async function LibraryPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = filtersFromParams(params);
  const { templates } = getLibrary();
  const result = queryLibrary(templates, filters, pageFromParams(params));

  const hasFilters = result.activeFilterCount > 0;

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Template library</h1>
      <p className="mt-1 text-sm text-ink-muted">
        {templates.length} templates from the organisation&apos;s exported library.
      </p>

      {/* A GET form: no client state, no JavaScript required, and the result is a URL
          that can be sent to a colleague. Active facets ride along as hidden fields so
          a new search narrows the current view instead of silently resetting it. */}
      <form method="get" action="/" role="search" className="mt-6">
        {FACET_KEYS.map((key) =>
          filters[key] === '' ? null : (
            <input key={key} type="hidden" name={key} value={filters[key]} />
          ),
        )}

        <label htmlFor="q" className="mb-1 block text-sm font-medium">
          Search templates
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={filters.q}
            placeholder="Chest, CT abdomen, clinical history…"
            autoComplete="off"
            enterKeyHint="search"
            className="w-full max-w-md rounded border border-line-strong bg-surface px-3 py-2 text-base"
          />
          <button
            type="submit"
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:bg-accent-hover"
          >
            Search
          </button>
          {hasFilters ? (
            <a
              href={libraryHref(withoutFilters(filters))}
              className="self-center text-sm text-accent underline hover:text-accent-hover"
            >
              Clear filters
            </a>
          ) : null}
        </div>
      </form>

      <div className="mt-8 grid gap-8 md:grid-cols-[16rem_minmax(0,1fr)]">
        <aside aria-labelledby="filters-heading" className="no-print">
          <h2 id="filters-heading" className="mb-3 text-sm font-semibold">
            Filters
          </h2>
          <div className="space-y-4">
            {FACET_KEYS.map((key) => (
              <FacetGroup
                key={key}
                facetKey={key}
                title={FACET_TITLES[key]}
                options={result.facets[key]}
                filters={filters}
              />
            ))}
          </div>
        </aside>

        <section aria-labelledby="results-heading">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="results-heading" className="text-sm font-semibold">
              Results
            </h2>
            <p className="text-sm text-ink-muted tabular-nums">
              {result.total} {result.total === 1 ? 'template' : 'templates'}
            </p>
          </div>

          {result.items.length === 0 ? (
            <p className="rounded border border-line bg-surface-muted p-4 text-sm">
              No templates match this search.{' '}
              <a
                className="text-accent underline hover:text-accent-hover"
                href={libraryHref(withoutFilters(filters))}
              >
                Clear the filters
              </a>{' '}
              or search for a body part.
            </p>
          ) : (
            <ol className="space-y-3">
              {result.items.map((template) => (
                <li key={template.id}>
                  <TemplateCard template={template} />
                </li>
              ))}
            </ol>
          )}

          <Pagination page={result.page} pageCount={result.pageCount} filters={filters} />
        </section>
      </div>
    </>
  );
}
