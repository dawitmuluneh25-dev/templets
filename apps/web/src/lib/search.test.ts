import { describe, expect, it } from 'vitest';

import type { TemplateRecord } from './corpus.js';
import {
  EMPTY_FILTERS,
  PAGE_SIZE,
  filtersFromParams,
  libraryHref,
  pageFromParams,
  queryLibrary,
  withFacet,
  type LibraryFilters,
} from './search.js';

function template(partial: Partial<TemplateRecord> & { id: string; name: string }): TemplateRecord {
  return {
    base_name: partial.name,
    variant_label: partial.name,
    scope: 'AlemHealth',
    modality: ['XR'],
    type: 'FREE_TEXT',
    status: 'Active',
    provenance: 'org_authored',
    sections: ['FINDINGS', 'IMPRESSION'],
    fields: [],
    tokens: [],
    char_count: 0,
    ...partial,
  };
}

const chest: TemplateRecord = template({
  id: 't1',
  name: 'XR Chest',
  modality: ['XR'],
  type: 'STRUCTURED',
  sections: ['FINDINGS', 'IMPRESSION'],
});

const ctAbdomen: TemplateRecord = template({
  id: 't2',
  name: 'CT Abdomen',
  modality: ['CT'],
  type: 'FREE_TEXT',
  provenance: 'third_party',
  sections: ['EXAM', 'IMPRESSION'],
});

const mriBrain: TemplateRecord = template({
  id: 't3',
  name: 'MRI Brain',
  modality: ['MR', 'MRV'],
  type: 'FREE_TEXT',
  scope: 'Publicly Shared',
  provenance: 'unattributed',
  sections: ['CLINICAL HISTORY', 'IMPRESSION'],
});

const all = [chest, ctAbdomen, mriBrain];

function filters(partial: Partial<LibraryFilters>): LibraryFilters {
  return { ...EMPTY_FILTERS, ...partial };
}

describe('library search', () => {
  it('returns everything, sorted as given, when unfiltered', () => {
    const page = queryLibrary(all, EMPTY_FILTERS, 1);

    expect(page.total).toBe(3);
    expect(page.items.map((item) => item.id)).toEqual(['t1', 't2', 't3']);
    expect(page.activeFilterCount).toBe(0);
  });

  it('requires every query term, so a second word narrows', () => {
    expect(queryLibrary(all, filters({ q: 'chest' }), 1).items.map((i) => i.id)).toEqual(['t1']);
    expect(queryLibrary(all, filters({ q: 'ct chest' }), 1).total).toBe(0);
  });

  it('matches sections as well as names', () => {
    // The heading is the body part a radiologist actually remembers.
    expect(queryLibrary(all, filters({ q: 'clinical history' }), 1).items.map((i) => i.id)).toEqual(
      ['t3'],
    );
  });

  it('ignores case and accents', () => {
    const accented = [
      template({ id: 't9', name: 'Échographie Abdominale', sections: ['EXAM'] }),
      ...all,
    ];

    expect(queryLibrary(accented, filters({ q: 'ECHOGRAPHIE' }), 1).total).toBe(1);
    expect(queryLibrary(accented, filters({ q: 'échographie' }), 1).total).toBe(1);
  });

  it('applies facet filters as intersections', () => {
    const page = queryLibrary(all, filters({ type: 'FREE_TEXT' }), 1);

    expect(page.items.map((i) => i.id)).toEqual(['t2', 't3']);
  });

  it('counts facets with the other filters applied and their own dimension removed', () => {
    // The selected modality is CT, so the modality facet must still show what the other
    // modalities would yield — otherwise every alternative reads as zero and the
    // sidebar looks broken.
    const page = queryLibrary(all, filters({ modality: 'CT' }), 1);
    const modalityCounts = Object.fromEntries(
      page.facets.modality.map((option) => [option.value, option.count]),
    );

    expect(modalityCounts).toEqual({ CT: 1, MR: 1, MRV: 1, XR: 1 });

    // Selection is reported on the option that is actually active, so the UI can mark
    // it and offer to clear it.
    expect(page.facets.modality.find((option) => option.value === 'CT')?.selected).toBe(true);
    expect(page.facets.modality.find((option) => option.value === 'XR')?.selected).toBe(false);
    expect(page.facets.provenance.some((option) => option.selected)).toBe(false);

    // A different dimension is intersected with the selected one, so it does narrow.
    const narrowed = queryLibrary(all, filters({ modality: 'CT', type: 'STRUCTURED' }), 1);
    expect(narrowed.total).toBe(0);
  });

  it('clamps a page number that is out of range instead of returning an empty page', () => {
    expect(queryLibrary(all, EMPTY_FILTERS, 99).page).toBe(1);
    expect(queryLibrary(all, EMPTY_FILTERS, 0).page).toBe(1);
    expect(queryLibrary(all, EMPTY_FILTERS, Number.NaN).page).toBe(1);
    expect(queryLibrary(all, EMPTY_FILTERS, 1).pageCount).toBe(1);
  });

  it('pages at PAGE_SIZE boundaries', () => {
    const many = Array.from({ length: PAGE_SIZE + 5 }, (_, index) =>
      template({ id: `t${index}`, name: `Template ${String(index).padStart(3, '0')}` }),
    );

    const first = queryLibrary(many, EMPTY_FILTERS, 1);
    const second = queryLibrary(many, EMPTY_FILTERS, 2);

    expect(first.pageCount).toBe(2);
    expect(first.items).toHaveLength(PAGE_SIZE);
    expect(second.items).toHaveLength(5);
    expect(second.items[0]?.id).toBe(`t${PAGE_SIZE}`);
  });

  it('reports the active filter count for the "clear" affordance', () => {
    expect(queryLibrary(all, filters({ q: 'chest', modality: 'XR' }), 1).activeFilterCount).toBe(2);
  });
});

describe('query string parsing', () => {
  it('takes the first of a repeated key and defaults the rest', () => {
    const filters = filtersFromParams({ q: ['chest', 'head'], modality: 'XR' });

    expect(filters.q).toBe('chest');
    expect(filters.modality).toBe('XR');
    expect(filters.type).toBe('');
  });

  it('keeps an unknown facet value rather than dropping the filter', () => {
    // Dropping it would show every template while the URL claims a filter is on.
    const filters = filtersFromParams({ modality: 'ZZ' });

    expect(filters.modality).toBe('ZZ');
    expect(queryLibrary(all, filters, 1).total).toBe(0);
  });

  it('falls back to page 1 for a non-numeric page', () => {
    expect(pageFromParams({ page: 'three' })).toBe(1);
    expect(pageFromParams({})).toBe(1);
    expect(pageFromParams({ page: '4' })).toBe(4);
  });
});

describe('library urls', () => {
  it('round-trips filters through a href, omitting the default page', () => {
    const href = libraryHref(
      filters({ q: 'ct chest', modality: 'CT', provenance: 'third_party' }),
      1,
    );

    expect(href).toBe('/?q=ct+chest&modality=CT&provenance=third_party');
    expect(libraryHref(EMPTY_FILTERS, 1)).toBe('/');
    expect(libraryHref(EMPTY_FILTERS, 3)).toBe('/?page=3');
  });

  it('toggles a facet off when the same value is chosen again', () => {
    const once = withFacet(EMPTY_FILTERS, 'modality', 'CT');
    expect(once.modality).toBe('CT');
    expect(withFacet(once, 'modality', 'CT').modality).toBe('');
    expect(withFacet(once, 'modality', 'MR').modality).toBe('MR');
  });
});
