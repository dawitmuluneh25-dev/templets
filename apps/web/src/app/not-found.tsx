import Link from 'next/link';

export default function NotFound() {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">
        That template is not in the library. It may have been withdrawn, or the link may be from an
        older export.
      </p>
      <p className="mt-4 text-sm">
        <Link className="text-accent underline hover:text-accent-hover" href="/">
          ← Back to the template library
        </Link>
      </p>
    </>
  );
}
