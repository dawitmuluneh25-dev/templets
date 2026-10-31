import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Offline',
};

/**
 * The only HTML the service worker ever stores.
 *
 * It is deliberately content-free: no template text, no patient context, nothing that
 * could be read off a shared device after the network comes back. Caching a real page
 * would mean caching whatever that page happened to contain, which is how a worker
 * starts holding PHI (risk R10).
 */
export default function OfflinePage() {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Offline</h1>
      <p className="mt-2 max-w-prose text-sm">
        This device cannot reach the reporting server. The library and reports are not available
        offline in this build — offline authoring arrives in P6, and until then showing stale
        template text would be worse than showing nothing.
      </p>
      <p className="mt-4 text-sm">
        <a className="text-accent underline hover:text-accent-hover" href="/">
          Try again
        </a>
      </p>
    </>
  );
}
