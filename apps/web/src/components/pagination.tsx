import type { LibraryFilters } from '@/lib/search';
import { libraryHref } from '@/lib/search';

interface PaginationProps {
  readonly page: number;
  readonly pageCount: number;
  readonly filters: LibraryFilters;
}

/**
 * Previous/next rather than numbered links: with 18 pages of templates the useful
 * actions are "further down the list" and "back", and a row of 18 targets costs a
 * screen-reader user more than it gives them.
 *
 * The unavailable direction is a disabled span, not a dead link — a link that reloads
 * the same page is a trap for keyboard and screen-reader users alike.
 */
export function Pagination({ page, pageCount, filters }: PaginationProps) {
  if (pageCount <= 1) return null;

  const linkClass =
    'rounded border border-line px-3 py-1.5 text-sm text-accent underline hover:bg-surface-muted';
  const disabledClass = 'rounded border border-line px-3 py-1.5 text-sm text-ink-muted opacity-60';

  return (
    <nav aria-label="Pagination" className="mt-6 flex items-center justify-between gap-4">
      {page > 1 ? (
        <a className={linkClass} href={libraryHref(filters, page - 1)} rel="prev">
          Previous
        </a>
      ) : (
        <span className={disabledClass} aria-disabled="true">
          Previous
        </span>
      )}

      <p className="text-sm text-ink-muted tabular-nums" aria-live="polite">
        Page {page} of {pageCount}
      </p>

      {page < pageCount ? (
        <a className={linkClass} href={libraryHref(filters, page + 1)} rel="next">
          Next
        </a>
      ) : (
        <span className={disabledClass} aria-disabled="true">
          Next
        </span>
      )}
    </nav>
  );
}
