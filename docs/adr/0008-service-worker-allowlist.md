# ADR-0008 — The service worker is an allowlist, not a precache

- **Status:** Proposed (needs the project owner's signature; it records a choice the first web
  slice already had to make)
- **Date:** 2026-10-29
- **Relates to:** ADR-0006 (PWA row), plan §4, risk R10; ADR-0002

## Context

ADR-0006 ratifies "Serwist/Workbox with an explicit allowlist" for the offline shell, and says why:
"a hand-rolled SW re-implements precache and gets it wrong."

Building the first web slice ran into the reason that advice is half-right. The useful part of
Workbox *is* the precache manifest — it is what makes an installed app open offline. Precache is also
the mechanism by which a worker ends up holding HTML it was never meant to hold. On this product that
HTML is a report, and risk R10 is exactly that: "the service worker caches something it should not".

So the choice is not "Workbox or hand-rolled". It is "cache documents, or do not". Workbox configured
not to precache is a dependency that provides routing sugar and a build step, and no longer provides
the thing it was chosen for.

## Decision

**The service worker caches build-hashed static assets and one deliberately content-free `/offline`
page. It caches no HTML from any route, no API response, and nothing that could carry patient data.**

Concretely, `apps/web/public/sw.js`:

- caches paths matching `^/_next/static/` and `^/icons/` (immutable by construction), plus
  `/offline` and the manifest at install time;
- serves navigations network-first and falls back to `/offline` — never to a cached document;
- passes every non-GET and every cross-origin request straight through;
- is served with `Cache-Control: no-store` so a device cannot keep an old allowlist after a release.

Eight lines of allowlist, in a file short enough to read in one screen during a security review.

## Consequences

**Accepted:**

- **The app does not open offline.** It opens, and says it is offline. Real offline authoring is P6
  and needs an explicit decision about what may be stored on a device (D7 — offline signing — is
  still open), so an app that half-works offline now would pre-empt that decision with a cache.
- **We own the Worker lifecycle.** Version constant, activate-time purge, `skipWaiting` semantics.
  That is roughly 30 lines and it is the 30 lines most likely to be wrong on a hospital network; the
  mitigation is that failure is visible (a stale shell) rather than silent (stale clinical text).
- **Adopting Workbox later is a change, not a refactor**: it will need this ADR superseded, because
  the decision being changed is what may be cached, not which library does the caching.

**Made easier:**

- The R10 control is auditable by reading one file, and the test that matters ("no clinical route is
  ever cached") is a statement about an allowlist rather than about a generated manifest.

## Alternatives considered

| Alternative | Why not now |
|---|---|
| Serwist/Workbox with a narrow precache (shell + library) | Precache is all-or-nothing per route. The library page is safe today and will not be once it links real reports; encoding "safe until it isn't" in a build manifest is how the guarantee quietly expires. |
| Cache nothing at all, no worker | Loses installability and the offline fallback, which are cheap to keep and are the PWA requirement. |
| Cache-first for `/` | Fastest cold start, and caches whatever that page contained on the day it was cached. Rejected outright on R10. |

## Revisit triggers

- **P6 defines what a device may store** → this ADR is superseded by one that names the store
  (Dexie), the encryption (WebCrypto), the retention rule, and the purge-on-sign-out behaviour.
- **Installability is required as an offline-first guarantee** → same trigger: it cannot be met
  without deciding what is stored, and that is a compliance question (D7), not a caching one.
