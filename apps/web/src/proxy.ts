import { NextResponse, type NextRequest } from 'next/server';

/**
 * Content-Security-Policy, with a per-response nonce.
 *
 * `'strict-dynamic'` plus a nonce is the only combination that lets Next's own
 * bootstrap scripts run without `'unsafe-inline'`. The header is set on the *request*
 * as well as the response because that is how Next learns the nonce to stamp onto the
 * script tags it emits; setting it on the response alone leaves the inline bootstrap
 * blocked and the page renders but never hydrates.
 *
 * `style-src` keeps `'unsafe-inline'`: styles are emitted as an inline `<style>` block by
 * the framework, and style injection is not a script-execution primitive. `font-src` is
 * `'self'` because ADR-0006 forbids a font host — there is no third-party origin in this
 * policy at all, which is the point.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = btoa(crypto.randomUUID());

  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', policy);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Static assets, the worker and the probe do not need a policy, and giving each
      // request a middleware hop would put a nonce on a cached byte stream it cannot
      // belong to.
      source: '/((?!_next/static|_next/image|icons|manifest.webmanifest|sw.js|health).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
