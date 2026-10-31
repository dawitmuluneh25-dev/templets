import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { ServiceWorker } from '@/components/service-worker';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'AlemHealth Reporting',
    template: '%s · AlemHealth Reporting',
  },
  description: 'Radiology reporting workbench — template library and report authoring.',
  applicationName: 'AlemHealth Reporting',
  manifest: '/manifest.webmanifest',
  // An internal clinical tool. It must never be indexed, and a crawler finding it is a
  // deployment mistake worth failing visibly.
  robots: { index: false, follow: false, nocache: true },
  formatDetection: { telephone: false, address: false, email: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // No `maximumScale`/`userScalable: false`: pinch-zoom is an accessibility requirement
  // (WCAG 1.4.4), not a layout preference.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0e1116' },
  ],
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-accent focus:px-4 focus:py-2 focus:text-accent-ink"
        >
          Skip to content
        </a>

        <header className="no-print border-b border-line bg-surface-muted">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <span className="text-sm font-semibold tracking-tight">AlemHealth Reporting</span>
            <nav aria-label="Primary" className="text-sm">
              <ul className="flex items-center gap-4">
                <li>
                  <a className="text-accent underline hover:text-accent-hover" href="/">
                    Template library
                  </a>
                </li>
              </ul>
            </nav>
          </div>
        </header>

        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
          {children}
        </main>

        <footer className="no-print border-t border-line px-4 py-4 text-xs text-ink-muted">
          <div className="mx-auto max-w-6xl">
            Template wording is reproduced from the organisation&apos;s own library. Reports are not
            signed in this build — signing arrives with the identity provider (E9).
          </div>
        </footer>

        <ServiceWorker />
      </body>
    </html>
  );
}
