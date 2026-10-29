import type { NextConfig } from 'next';

/**
 * Self-hosted, single-tenant, no CDN and no font host (ADR-0006 §2). Everything the
 * shell loads comes from this origin, which is what makes the service worker's
 * allowlist trustworthy later.
 *
 * `standalone` produces the self-contained server bundle the Dockerfile copies; it
 * is also why the corpus artefact is read from a path fixed at build time rather
 * than from whatever the working directory happens to be.
 */
const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,

  // Examined here once rather than per-request in a middleware: these are static
  // for every response and do not depend on a nonce.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          // No camera, microphone or location on any screen: there is no feature
          // that needs them, and asking the user would be a phishing pattern.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // Report-only until a deployment terminates TLS; HSTS on a plain-HTTP
          // origin would make the first mistake permanent.
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
      {
        // The service worker must not be cached by the browser, or a device keeps
        // the old allowlist after a release.
        source: '/sw.js',
        headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }],
      },
    ];
  },
};

export default config;
