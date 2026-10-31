'use client';

import { useEffect } from 'react';

/**
 * Route-level error boundary.
 *
 * Only the digest is reported, never `error.message`: on this product an error message
 * can contain a fragment of clinical text, and a client-side log is a place PHI must
 * never reach. The digest is enough to find the server-side stack.
 */
export default function RouteError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  useEffect(() => {
    console.error('route error', { digest: error.digest ?? 'none' });
  }, [error.digest]);

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">
        This screen could not be rendered. Nothing has been saved or signed as a result.
      </p>
      {error.digest === undefined ? null : (
        <p className="mt-2 font-mono text-xs text-ink-muted">Reference: {error.digest}</p>
      )}
      <button
        type="button"
        onClick={reset}
        className="mt-4 rounded bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:bg-accent-hover"
      >
        Try again
      </button>
    </>
  );
}
