'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker, in production only.
 *
 * Development is excluded deliberately: a stale worker in front of a dev server is the
 * classic "my change did nothing" afternoon. Registration failure is swallowed because
 * the app is fully server-rendered — offline support is an enhancement here, not a
 * prerequisite for reading a template, and a modal about it would interrupt a clinician
 * for no clinical reason.
 */
export function ServiceWorker(): null {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    const register = (): void => {
      void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    };

    window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}
