import type { TemplateRecord } from './corpus.js';

/**
 * Library search, faceting and pagination.
 *
 * Pure functions over the corpus so the behaviour can be tested without a browser, a
 * server or a database. The page component does the query-string parsing and the
 * rendering; everything that can be wrong about *which* templates match lives here.
 *
 * The facet rule is the standard one and is worth stating because getting it wrong is
 * invisible until someone uses two filters: the count beside an option is the number of
 * results you would get if you chose it, so it is computed with every *other* filter
 * applied and this dimension removed. Counting within the fully filtered set collapses
 * every unselected option to zero, which makes the sidebar look broken.
 */

export const PAGE_SIZE = 24;

export type FacetKey = 'modality' | 'type' | 'scope' | 'provenance';

export const FACET_KEYS: readonly FacetKey[] = ['modality', 'type', 'scope', 'provenance'];

export interface LibraryFilters {
  readonly q: string;
  readonly modality: string;
  readonly type: string;
  readonly scope: string;
  readonly provenance: string;
}

export const EMPTY_FILTERS: LibraryFilters = {
  q: '',
  modality: '',
  type: '',
  scope: '',
  provenance: '',
};

export interface FacetOption {
  readonly value: string;
  /** Human-facing, e.g. `third_party` → `Third party`. */
  readonly label: string;
  readonly count: number;
  readonly selected: boolean;
}

export type Facets = Readonly<Record<FacetKey, readonly FacetOption[]>>;

export interface LibraryPage {
  readonly items: readonly TemplateRecord[];
  readonly total: number;
  /** 1-based and always within `1..pageCount`, even when the requested page is not. */
  readonly page: number;
  readonly pageCount: number;
  readonly facets: Facets;
  readonly filters: LibraryFilters;
  readonly activeFilterCount: number;
}

/** Case- and accent-insensitive. `CT Abdomen` and `ct abdomen` are the same query. */
export function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(query: string): readonly string[] {
  const normalized = normalize(query);
  return normalized === '' ? [] : normalized.split(' ');
}

/**
 * Everything a template can be found by. Sections are included because radiologists
 * search for a body part that appears in a heading far more often than for a template
 * name they half-remember.
 */
function haystack(template: TemplateRecord): string {
  return normalize(
    [
      template.name,
      template.base_name,
      template.variant_label,
      template.modality.join(' '),
      template.sections.join(' '),
    ].join(' '),
  );
}

function facetValues(template: TemplateRecord, key: FacetKey): readonly string[] {
  return key === 'modality' ? template.modality : [template[key]];
}

function matchesQuery(template: TemplateRecord, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const hay = haystack(template);
  // Every term must appear: "ct chest" narrows rather than widens.
  return terms.every((term) => hay.includes(term));
}

function matchesFacets(
  template: TemplateRecord,
  filters: LibraryFilters,
  skip: FacetKey | undefined,
): boolean {
  for (const key of FACET_KEYS) {
    if (key === skip) continue;
    const wanted = filters[key];
    if (wanted === '' || wanted === undefined) continue;
    if (!facetValues(template, key).includes(wanted)) return false;
  }
  return true;
}

/** `third_party` → `Third party`; `FREE_TEXT` stays as the corpus wrote it. */
export function facetLabel(key: FacetKey, value: string): string {
  if (key !== 'provenance') return value;
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function buildFacet(
  templates: readonly TemplateRecord[],
  filters: LibraryFilters,
  terms: readonly string[],
  key: FacetKey,
): readonly FacetOption[] {
  const counts = new Map<string, number>();

  for (const template of templates) {
    if (!matchesQuery(template, terms)) continue;
    if (!matchesFacets(template, filters, key)) continue;
    for (const value of facetValues(template, key)) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  const selected = filters[key];

  return [...counts.entries()]
    .map(([value, count]) => ({
      value,
      label: facetLabel(key, value),
      count,
      selected: value === selected,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'en'));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export function queryLibrary(
  templates: readonly TemplateRecord[],
  filters: LibraryFilters,
  requestedPage: number,
): LibraryPage {
  const terms = tokenize(filters.q);

  const matched = templates.filter(
    (template) => matchesQuery(template, terms) && matchesFacets(template, filters, undefined),
  );

  const total = matched.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = clamp(requestedPage, 1, pageCount);
  const start = (page - 1) * PAGE_SIZE;

  const facets: Facets = {
    modality: buildFacet(templates, filters, terms, 'modality'),
    type: buildFacet(templates, filters, terms, 'type'),
    scope: buildFacet(templates, filters, terms, 'scope'),
    provenance: buildFacet(templates, filters, terms, 'provenance'),
  };

  const activeFilterCount =
    FACET_KEYS.filter((key) => filters[key] !== '').length + (filters.q === '' ? 0 : 1);

  return {
    items: matched.slice(start, start + PAGE_SIZE),
    total,
    page,
    pageCount,
    facets,
    filters,
    activeFilterCount,
  };
}

/**
 * The canonical URL for a set of filters and a page.
 *
 * Every control on the page is a link or a GET form built from this, which is why the
 * library works with JavaScript disabled and why a filtered view can be bookmarked and
 * sent to a colleague.
 */
export function libraryHref(filters: LibraryFilters, page = 1): string {
  const params = new URLSearchParams();

  if (filters.q !== '') params.set('q', filters.q);
  for (const key of FACET_KEYS) {
    const value = filters[key];
    if (value !== '') params.set(key, value);
  }
  if (page > 1) params.set('page', String(page));

  const query = params.toString();
  return query === '' ? '/' : `/?${query}`;
}

/** Applies one facet value, or clears it when the same value is chosen again. */
export function withFacet(filters: LibraryFilters, key: FacetKey, value: string): LibraryFilters {
  return { ...filters, [key]: filters[key] === value ? '' : value };
}

export function withoutFilters(filters: LibraryFilters): LibraryFilters {
  return { ...EMPTY_FILTERS, q: filters.q };
}

/** A query string as Next hands it over: repeated keys arrive as an array. */
export type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/**
 * Reads filters from the URL. Unknown keys are ignored and unknown values are kept —
 * they simply match nothing, which is honest: a hand-edited `?modality=US` should show
 * an empty result set rather than silently dropping the filter and showing everything.
 */
export function filtersFromParams(params: SearchParams): LibraryFilters {
  return {
    q: first(params['q']).slice(0, 200),
    modality: first(params['modality']).slice(0, 40),
    type: first(params['type']).slice(0, 40),
    scope: first(params['scope']).slice(0, 80),
    provenance: first(params['provenance']).slice(0, 40),
  };
}

export function pageFromParams(params: SearchParams): number {
  const parsed = Number.parseInt(first(params['page']), 10);
  return Number.isFinite(parsed) ? parsed : 1;
}
