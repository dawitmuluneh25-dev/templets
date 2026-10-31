# apps/web

The web client. This is **P2 step 1**: the shell and the template library, server-rendered. The
editor island (ProseMirror) is the next milestone and is not in this build — see *What is not here*.

Next.js App Router, self-hosted, no CDN, no font host (ADR-0006).

## Run it

```powershell
pnpm install                 # once, from the repository root
pnpm corpus                  # regenerates corpus/generated/templates.json
pnpm --filter @reporting/web dev
```

The app reads `corpus/generated/templates.json` (≈1.9 MB, committed). `CORPUS_PATH` overrides it; the
container sets it explicitly. If the artefact is missing or malformed the process refuses to start —
a server that boots with an empty library fails as "no templates found" in a clinical setting, which
is a worse failure than a crash.

## What is real

| Capability | Where |
|---|---|
| Search across name, variant, modality and section headings | [src/lib/search.ts](src/lib/search.ts) |
| Faceted filtering with correct cross-facet counts | `queryLibrary` in the same file |
| Pagination, with the page clamped into range | `queryLibrary` |
| Every view addressable by URL; works without JavaScript | `libraryHref`, GET form on `/` |
| Template rendering from the canonical token model | [src/lib/render.ts](src/lib/render.ts) |
| PWA manifest, installable shell | `public/manifest.webmanifest` |
| Service worker with a cache allowlist | `public/sw.js` |
| Health probe that fails when the library does not load | `src/app/health/route.ts` |
| CSP with a per-response nonce | `src/middleware.ts` |

## Decisions worth knowing

**The URL is the state.** Filters are query parameters and every control is a link or a GET form.
No client-side filter state, so the page works with JavaScript off, a filtered view is a bookmark,
and "the view my colleague is looking at" is a link rather than a description.

**Facet counts exclude their own dimension.** The number beside "CT" is what you would get by choosing
it, computed with the other filters applied. Counting inside the fully filtered set collapses every
alternative to zero and makes the sidebar look broken — the failure is invisible until someone uses two
filters, so it is covered by a test.

**Rendering is lossless.** Text tokens are emitted with `white-space: pre-wrap`; nothing is
reflowed, trimmed or re-paragraphed. The wording is what a signature will attest (ADR-0005). An
unknown token kind throws rather than being skipped, because a schema version we do not understand
must not silently delete clinical text.

**Tailwind, but not Radix.** The ratified stack is "Tailwind + Radix on CSS-variable tokens"
(ADR-0006). Tailwind is in place and the tokens are the single source of colour and rhythm. Radix is
deliberately **not** installed yet: this slice needs no dialog, popover, combobox or menu, and the
project's rule is that a dependency arrives with the first thing that asserts it. The editor island
needs it (toolbar, dialogs), and that is when it lands.

**No Workbox/Serwist.** ADR-0006 asks for it to avoid hand-rolled precaching. This worker does no
precaching at all: it caches build-hashed static assets and a deliberately content-free `/offline`
page, and nothing else. The failure mode the ADR warns about is a precache manifest that quietly
includes clinical HTML; the control here is an allowlist of two path patterns, readable in one screen
(risk R10).

## Accessibility

Target is WCAG 2.2 AA, and the parts that are actually verifiable at this stage are:

- semantic landmarks (`header`/`main`/`nav`/`footer`), one `h1` per page, headings in order;
- a skip link as the first focusable element;
- one focus-visible treatment for the whole app, defined once in `globals.css`;
- native controls only — search input, submit button, links — so keyboard and screen-reader
  behaviour is the platform's, not ours;
- filter state announced with `aria-current`, counts included in the link text rather than an
  `aria-label`, so what is read matches what is seen;
- disabled pagination rendered as a non-focusable span, never as a link that reloads the page;
- `prefers-reduced-motion` honoured, `prefers-color-scheme` supported;
- zoom not blocked (`maximumScale` is omitted on purpose);
- body-text contrast ≥ 7:1 in both schemes.

Not yet verified: a real screen-reader pass, and an axe run in CI. Both belong to P7 and neither is
claimed here.

## Performance

Server-rendered, so the first paint carries the content. The client bundle is the Next runtime plus a
service-worker registration; there is no application state library, no data fetching on the client and
no third-party script. The corpus is parsed once per process and cached; a page is a filter over 427
in-memory records.

## Security

- `Content-Security-Policy` with a per-response nonce and `'strict-dynamic'`; no `'unsafe-inline'` for
  scripts, no third-party origin in the policy at all.
- `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
  `Permissions-Policy` denying camera/microphone/geolocation, HSTS.
- `robots: noindex, nofollow` — an internal clinical tool should not be crawlable.
- No PHI in the service worker cache, by allowlist (see above).
- No PHI in logs: the error boundary reports a digest, never `error.message`, and nginx access
  logging is off because a report URL contains a report id.

**Not done yet, and deliberately:** there is no authentication. The API has an `Authenticator`
interface with a fail-closed default; this web app talks to no API, has no session, and shows no
patient data. It must not be deployed where it can reach real reports until E9 (IdP) is met.

## Deployment

```powershell
docker build -f apps/web/Dockerfile -t reporting-web .
```

[nginx.conf](nginx.conf) terminates TLS and proxies to `web:3000`. `/health` returns
`{"status":"ok","templates":427}` or `503` with `library_unavailable`.

> The Dockerfile has **not been executed** in the build environment — Docker is absent there. It
> follows the documented pnpm-workspace `standalone` layout and should be treated as unverified until
> the first real build.

## Tests

```powershell
pnpm test        # from the repository root; picks up apps/web/src/**/*.test.ts
```

Covered: search terms and AND semantics, section matching, accent/case folding, facet intersection,
cross-facet counting, page clamping and boundaries, URL round-tripping, query-string parsing, and the
token projection (including refusal of an unknown token kind). Not covered: React components — there
is no component test runner in this workspace yet, and adding one for three presentational components
would be the tail wagging the dog. Playwright (six viewports) is in the plan for P7.

## What is not here

- **The editor island.** Authoring is the next milestone: ProseMirror with a constrained schema and
  atomic field nodes, Redux Toolkit for the document/command log, Dexie for drafts. Until then this
  app is read-only, and it says so on the report screen rather than pretending otherwise.
- **Authentication and the API.** No session, no fetch, no signing. `apps/api` is a separate slice
  with its own tests; wiring them is P3 work and depends on E9.
- **Export and delivery.** Server-rendered PDF is a worker job (P4), not a browser download.
- **i18n.** The interface is English; the corpus is the customer's own language and is never
  translated.
