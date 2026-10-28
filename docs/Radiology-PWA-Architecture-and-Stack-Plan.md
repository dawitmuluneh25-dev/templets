# Radiology Reporting PWA — Greenfield Plan and Recommended Stack

Two questions, answered against the real constraints of this project: 427 exported templates
(301 templates + 126 variants, 2,381 typed fields across 258 of them), a signed-report workflow,
PHI on the device, and users who work in dark rooms on locked-down hospital networks.

The first half is how I would run the build if starting today, informed by what actually broke in
the prototype. The second half is the stack I would choose for production, with the reasoning and
the rejections.

---

# Part 1 — If I were starting from scratch

## 1.0 Framing: what kind of project this actually is

It is easy to describe this as "a form app with templates". That framing produces the wrong
architecture. Three properties make it something else:

1. **It emits a clinical document.** Once signed, the output is the record. That makes every
   transformation between template and output a potential documentation defect, and it makes
   "the template changed under a saved report" a medico-legal problem, not a UI bug.
2. **It holds PHI on an endpoint.** Not just in transit — in IndexedDB, in a journal, in export
   files on the desktop, in the clipboard, potentially in a service worker cache and in logs.
   The threat model has to enumerate all of those, and most of them are easy to forget.
3. **It must work when the network does not.** Radiology downtime procedures are real. A reporting
   tool that dies with the network is a tool that gets abandoned after the first outage.

Those three properties drive nearly every decision below. Everything else — framework, styling,
state library — is downstream and replaceable.

## 1.1 Phase 0 — Constraints and regulatory framing (week 0, before code)

The cheapest phase and the one most often skipped. Deliverables:

- **A written scope statement of what the software does not do.** It structures, validates,
  stores, and transmits text authored by a physician. It does not interpret images, suggest
  diagnoses, or compute measurements into a conclusion. That distinction is what keeps a reporting
  editor on the "documentation tool" side of medical-device regulation in most jurisdictions rather
  than triggering a full QMS/SaMD programme. Get it reviewed by whoever owns regulatory affairs, and
  keep it current — the moment someone adds "auto-suggest impression from findings", the analysis
  changes and the paperwork with it.
- **Data-flow and PHI inventory.** One diagram listing every location PHI can reach: IndexedDB,
  journal, exports, clipboard, service worker cache, browser history, crash reporting, analytics,
  server logs, backups. Each location gets a control or an explicit accepted risk. In the prototype
  this produced the rule *"the service worker caches static assets and the template library, never
  an API response"* — a rule that has to be written down because the default Workbox recipe does the
  opposite.
- **Deployment reality check.** Intranet-only or internet-facing? Which IdP (Entra ID, Keycloak,
  ADFS)? Is there an MDM? Which browser versions are actually installed in the reading room
  (frequently older than the org believes)? Is dictation via a microphone, a Philips/Nuance client,
  or keyboard macros? Each answer changes a technical decision, and guessing wrong costs a rebuild.
- **Template licensing.** Resolve before writing the export path. 130 of the 427 files are
  RSNA-authored and 127 come from other platform users; only ~170 are plausibly own-organisation
  content. Shipping derivative works of third-party templates without a licence is the single
  largest unresolved legal risk in this corpus, and it is far cheaper to settle now than after
  hospitals have authored reports on top of them.
- **Success metrics, numeric.** Time-to-signed-report versus the current workflow, percentage of
  reports needing addenda, template round-trip fidelity, and downtime-reporting capability. Without
  a baseline measured *before* rollout, "it feels faster" is the only evidence available later.

**Gate to Phase 1:** scope statement signed, PHI inventory reviewed, licensing position written
down, deployment target known.

## 1.2 Phase 1 — Corpus-first: the template library is the specification

I would not open a UI framework until the template corpus has been converted into a machine-checked
schema. In the prototype this was the correct call and it paid for itself: the importer found the
nested placeholders, the space-before-colon heading, the `\u00a0` escape artefacts, and the
two structural families (prose with `SECTION:` headings vs. `## SECTION` markdown) before any of
them could become editor bugs.

Concretely:

1. **Freeze the source.** Hash every source file, store a manifest, and never read the live platform
   again during the build. `corpus-manifest.json` with `path`, `sha256`, `scope`, `author`,
   `modality`, `type`, `guid`, `status`.
2. **Write the token grammar down.** A template body is a sequence of `text`, `heading`, and `field`
   tokens. Fields have a type (`enum`, `number`, `multislot`, `dateOrNone`, `text`) and carry the
   verbatim raw placeholder. The grammar is a document, not tribal knowledge.
3. **Make fidelity a test, not a review.** `render(parse(body)) === body` for all 427 files, run in
   CI. Anything that fails is quarantined, never silently repaired — altered clinical wording is
   worse than a missing template. Target 427/427, and treat a drop as a build break.
4. **Decide the immutability question here, not in the editor.** Does a report re-render from the
   live template, or is it a snapshot taken at creation? It must be a snapshot with a pinned
   `template_version_id`. Otherwise editing a template retroactively rewrites reports that were
   already signed. In the prototype this is enforced with `contentHash` + `baselineHash`; in a
   production build it belongs in the data model, with templates append-only and versioned.
5. **Build the field inventory report.** Which fields are shared across templates (measurement units,
   prior-study references, laterality), which are template-specific, and which placeholders are
   compounds that will need sub-field decomposition later (262 of them in this corpus). This report
   is the backlog for the field-editor work.

**Gate:** 427/427 round-trip in CI, grammar documented, template versioning model decided.

## 1.3 Phase 2 — Architecture and risk spikes

Before committing to a stack, run five timeboxed spikes, each with a written kill criterion. These
are the questions where a wrong answer is discovered late and expensively:

| Spike | Question | Kill criterion |
|---|---|---|
| **Render performance** | Can a document with 10+ sections and 40 fields stay under 16 ms per keystroke on a 5-year-old laptop? | Any per-keystroke full re-render → change the document-state design now |
| **PDF determinism** | Can the same report render byte-identical output twice, on two machines? | Font or layout drift → server-side renderer with pinned Chromium/Typst, decided now |
| **Persistence durability** | Does IndexedDB survive a hard tab kill mid-write, and what is the actual quota on hospital hardware? | Loss window > 1 s → add the journal layer |
| **Layout under constraint** | Do sticky/positioned panels behave with `100dvh`, a variable top bar, and mobile URL-bar resize? | Any geometry ambiguity → a single scroll-container design, not nested scrollers |
| **Crypto at rest** | Can drafts be unreadable after lock without a UX dead end? | Passphrase recovery story unresolved → escalate to product, not to code |

The layout spike looks cosmetic and is not: in the prototype, three of the most serious defects were
geometry or state-lifecycle problems that no unit test could see — a drawer that overlapped the top
bar by 21 px because a fixed flex container with `min-height: auto` grew upward from `bottom: 0`;
save listeners from a previously opened report still painting into the new one; an "Offline save"
that reported "Saved". A spike that measured those five properties in a real browser would have
found all three in an afternoon.

**Gate:** every spike has a decision recorded in an ADR (architecture decision record), including
the ones where "we accept this risk" is the decision.

## 1.4 Phase 3 — One vertical slice, end to end

Pick the most common template family (chest radiograph, free-text) and build the whole path:

import → open → edit one typed field → validate → export PDF → sign → audit entry → visible in the
drafts list.

Ship that slice to two radiologists for a week of real (non-patient or synthetic) work. The point is
not to demo; it is to discover that "sign" needs a co-signature rule, that the IMPRESSION field is
where people actually pause, and that they paste from Word. Those findings reshape Phase 4 and cost
nothing yet.

**Gate:** a radiologist can complete a report without a developer in the room.

## 1.5 Phase 4 — Breadth

Now build laterally, in this order, because each depends on the previous:

1. **Corpus breadth** — full library, search, facets (modality, type, scope), variant grouping.
2. **Document breadth** — both structural families, all five field types, compound placeholders as
   single fields first (decomposition is a later, admin-reviewed change).
3. **Validation breadth** — the three-tier model. Hard blocks sign-off, soft requires an
   acknowledgement that is logged, nudge is advisory. Required-ness is per template, never global:
   35 templates in this corpus have no IMPRESSION section and 10 have no FINDINGS, so a global rule
   makes a fifth of the library unsignable.
4. **Drafts and recovery** — the list, the recovery banner with Restore/Discard, and honest status
   labels. A successful local write while offline is not "Saved"; it is "Offline — saved locally".
5. **Audit and settings** — local activity log first, server-side hash-chained audit later.

Every tier of validation gets a golden-file test built from real templates, because the rule set is
where clinical risk concentrates.

## 1.6 Phase 5 — Hardening (the offline matrix)

The phase most projects compress into a week and most hospitals notice missing. Test matrix:

- Kill the tab mid-keystroke, kill the browser, kill the OS, pull the network, come back 10 minutes later.
- Quota exhaustion (fill storage deliberately), corrupted IndexedDB record, clock skew across tabs.
- Two tabs editing the same report — last-write-wins is not acceptable silently; detect and warn.
- A 12-page report, a 4,000-word IMPRESSION, RTL text pasted in, an emoji, a Word paste with nested
  tables, and a paste containing a literal `[...]` (which will trip the placeholder-leak check and
  must be distinguishable from an unfilled field).
- Update-during-edit: a new service worker activating while a dirty document is open.

**Gate:** a written downtime test that a non-developer can execute.

## 1.7 Phase 6 — Clinical validation and rollout

- **Shadow mode**: run alongside the existing workflow for 2–4 weeks. Compare exports for the same
  cases; any semantic difference is a bug in either the template import or the field mapping.
- **Usability testing**: 5–8 radiologists, timed tasks, think-aloud. Measure time-to-sign and error
  rate against the Phase 0 baseline, not satisfaction scores.
- **Accessibility conformance**: WCAG 2.2 AA, verified with axe plus a manual screen-reader pass.
  Not optional in a clinical setting — low-vision and motor-impairment users are a real population.
- **Rollout**: pilot one modality, then one site, then organisation-wide, with a documented
  rollback (the previous system stays readable for the retention period).

## 1.8 The twelve decisions that matter

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| 1 | Report is an immutable **snapshot** of a pinned template version | Re-render from live template | Live templates silently rewrite signed history |
| 2 | **Per-template** requiredness | Global "IMPRESSION required" | 35/427 templates lack IMPRESSION; global rules make them unsignable |
| 3 | **Three-tier** validation (hard / soft-with-ack / nudge) | Single pass/fail | Binary validation trains users to ignore it; acknowledgement is auditable intent |
| 4 | Unmodified template boilerplate is a **hard block** | Warn only | The default findings describe a hypothetical patient; signing them unread is the worst failure mode in the workflow |
| 5 | **Constrained schema editor** (ProseMirror/Lexical), not raw `contenteditable` | `contenteditable` + DOM serialisation | Caret/IME/undo/paste-sanitisation are not things to hand-roll; DOM→token serialisation is fragile by construction |
| 6 | **Local-first drafts, server-authoritative signatures** | Server-authoritative everything, or local everything | Authoring must survive downtime; a signature must be revocable by a server and timestamped |
| 7 | **Modular monolith** | Microservices | One team, one deployable, one database. Service boundaries at export/render and audit only |
| 8 | **PostgreSQL** with JSONB for token streams | Document DB | Signatures, audit chains and referential integrity want transactions and constraints |
| 9 | **Buy** auth (OIDC against the hospital IdP) | Build login | Credential handling is where security programmes fail; the hospital already has MFA and joiner/leaver |
| 10 | **Server-side** PDF for the record copy; client-side preview only | Client-only PDF | Byte-stable archival output needs a pinned renderer; the prototype's hand-written PDF writer was a constraint, not a design |
| 11 | Offline **authoring**, online **signing** | Fully offline signing | A signature needs server-side authority, timestamp and audit; pretending otherwise is theatre |
| 12 | **Version control from commit 1**, with the corpus as fixtures | "We'll add git later" | The prototype has no repository and therefore no history, no bisect, no rollback |

## 1.9 What I would do differently from the prototype, concretely

- **Git from the first file.** Today the project exists as files plus a ZIP; there is no commit
  history, no branching, and no way to bisect a regression. That is the cheapest defect to fix and
  the most expensive to have skipped.
- **Playwright from week one**, not manual browser QA at the end. Three of the worst defects were
  stateful-UI bugs invisible to unit tests.
- **TypeScript at the document-model boundary.** The token/field contract is currently enforced by
  convention and tests; the compiler should enforce it.
- **A schema-validated rich-text engine** instead of `contenteditable` + a serialiser.
- **Workbox/Serwist with an explicit cache allowlist**, and a deferred update path — `skipWaiting()`
  plus `clients.claim()` can swap the shell under an open editor.
- **A token file plus a lint rule**, so spacing and panel metrics cannot drift between the two
  sidebars again.
- **Automated a11y assertions** (axe in CI) rather than manual review.
- **Licensing resolved before the export path shipped**, not after.

## 1.10 Team, timeline, definition of done

Two engineers (one frontend-leaning full-stack, one backend), a designer at 50%, a radiologist
champion at ~2 h/week, and QA shared. Rough shape, assuming no procurement delays:

| Phase | Duration | Done means |
|---|---|---|
| 0 Framing | 1 week | Scope, PHI inventory, licensing position, metrics baseline |
| 1 Corpus | 2 weeks | 427/427 round-trip in CI; grammar + versioning decided |
| 2 Spikes | 1–2 weeks | Five ADRs written |
| 3 Vertical slice | 3 weeks | A radiologist signs a report unaided |
| 4 Breadth | 6–8 weeks | Full library, validation, drafts, audit |
| 5 Hardening | 2–3 weeks | Downtime test passes; update-during-edit safe |
| 6 Validation + rollout | 4–8 weeks | Shadow-mode parity, WCAG AA, pilot site live |

Roughly 20–26 engineering weeks to a pilot, with the long tail in Phase 6 being organisational
rather than technical.

---

# Part 2 — Recommended stack

## 2.0 Summary

| Layer | Recommendation | One-line rationale |
|---|---|---|
| **Deployment profile** | Docker on HIPAA-eligible cloud (BAA) or hospital Kubernetes | Determines auth, caching and update strategy; decide first |
| **Language** | TypeScript everywhere, strict mode | One schema shared by editor, API and tests |
| **Frontend** | React + **Next.js (App Router)**, self-hosted; editor as a client island | Server-rendered library/admin, client-only editor |
| **Alt frontend** | Vite + React SPA if the org has no Node runtime | Simpler static hosting on an intranet |
| **Editing engine** | **ProseMirror** with a constrained schema | Deterministic serialisation, correct IME/undo/paste |
| **Backend** | Node + **Fastify** modular monolith (`NestJS` if the team is larger) | Schema-first validation, low overhead, separable workers |
| **Jobs** | **BullMQ + Redis** | PDF render, notifications, audit sealing are not request work |
| **Database** | **PostgreSQL** (JSONB for token streams, RLS for tenancy) | Transactions, constraints, PITR, on-prem maturity |
| **Object storage** | S3 with Object Lock (or on-prem MinIO) for signed PDFs | WORM retention for the legal record |
| **Styling** | **Tailwind CSS + Radix primitives** (shadcn/ui pattern, copied in) | Tokens → CSS vars; accessibility primitives not hand-rolled |
| **State** | **Redux Toolkit** (document) + **TanStack Query** (server) + **Zustand** (ephemeral UI) | Three kinds of state, three failure modes |
| **Forms/validation** | **React Hook Form + Zod**, schemas shared with the API | Field types enforced once |
| **Testing** | **Vitest + Testing Library + Playwright + axe + fast-check** | E2E catches the bugs unit tests structurally cannot |
| **CI/CD** | GitHub Actions / GitLab CI → signed images, SBOM, staged rollout | Hospital procurement increasingly requires SBOM + provenance |
| **PWA** | **Serwist/Workbox** with allowlist, **Dexie** for IndexedDB, WebCrypto, manifest | Offline shell without caching PHI |
| **Observability** | OpenTelemetry + structured logs with PHI redaction | Auditability without leaking patient data |

## 2.1 Decide the deployment profile before anything else

This single choice reorders the rest of the list:

- **Profile A — managed cloud with a BAA** (AWS/Azure/GCP). Fastest to operate, easiest scaling,
  requires a signed Business Associate Agreement and a PHI-safe logging configuration.
- **Profile B — hospital-managed / on-prem Kubernetes.** Common in radiology, because the PACS
  integration and the network are already inside. It constrains you to: no managed services, no
  external CDN, self-hosted fonts, an internal registry, and an IdP you do not control.

Both are viable; the architecture below works for either. What does **not** work for PHI is a
frontend-hosted PaaS with no BAA (Vercel/Netlify as-is), a public CDN for the app shell, Google
Fonts, or a third-party error tracker with default settings. Those are the four most common
mistakes and each is a one-line configuration decision made early and painfully unwound later.

## 2.2 Frontend

**Recommendation: React with Next.js App Router in TypeScript, self-hosted in a container.**

- The application has five routes (`library`, `report/:id`, `drafts`, `audit`, `settings`) plus an
  admin surface for templates and users. A single Next.js app serves both; the template library,
  admin tables and audit views render on the server, the report editor is a client-only island
  because it must work offline.
- React is chosen for staffing, not elegance: hospital IT contractors, integration vendors and the
  hiring pool all speak React. With a 5-year clinical lifetime, maintainability by strangers
  outweighs framework preference.
- TypeScript in strict mode, with `noUncheckedIndexedAccess`, because the token model is a
  discriminated union and the compiler is the cheapest validator available.

**Alternative worth taking seriously:** a Vite + React single-page app behind nginx, if the
organisation has no appetite for a Node runtime. Offline-first editing does not need SSR, and a
static bundle on an intranet is operationally simpler. The cost is that admin/audit screens then
need their own API and hosting story.

**Rejected:** SvelteKit and Solid (smaller hiring pool for a clinical product), Angular (heavier
than needed and slower to attract contributors), and a no-framework build (correct for the prototype,
wrong for a multi-year product with several contributors).

## 2.3 Backend

**Recommendation: a modular monolith in TypeScript on Fastify, with worker processes.**

- Modules: `templates`, `reports`, `signatures`, `audit`, `exports`, `users`, `orgs`.
- Fastify over Express for schema-based validation and serialisation at the route boundary — the
  same Zod/JSON-Schema definitions the frontend uses for field types.
- NestJS if the team is larger than ~4 engineers: the opinionated module/DI structure pays off at
  that size and costs little below it.
- **Separate worker process for exports** (BullMQ + Redis). Rendering a 12-page PDF must not occupy
  a request thread, and it must be retryable and observable on its own.
- **Auth**: OIDC against the hospital IdP (Entra ID, Keycloak, Okta). Do not build login. Use
  Auth.js or the IdP's own SDK, PKCE, short-lived access tokens, refresh rotation, and step-up
  re-authentication before signing. If the EHR integration is in scope, support **SMART on FHIR**
  launch so the app can be opened contextually for a patient/study.
- **Audit**: append-only table with a per-record hash chain, written in the same transaction as the
  state change that produced it. Never reconstruct audit from logs.

**Rejected:** serverless functions for the signature path (cold starts and partial-failure semantics
are hostile to a transaction that must be exactly-once), and microservices (the operational cost is
real and the domain has three natural modules, not twelve).

## 2.4 Database

**Recommendation: PostgreSQL, with JSONB for the token stream and relational tables for everything
clinical.**

- `templates` (append-only, versioned), `template_versions` (immutable body + `content_hash`),
  `reports` (pins `template_version_id`), `report_sections`, `field_values`, `signatures`,
  `audit_events`, `users`, `orgs`, `exports`.
- JSONB holds the token stream because it is a document; the surrounding references stay relational
  so a report cannot point at a template version that does not exist.
- Row-level security for organisation tenancy — a mis-scoped query then returns nothing instead of
  another hospital's data.
- `pgcrypto` for column-level encryption of free-text PHI if the deployment requires encryption at
  rest beyond disk-level; otherwise rely on TDE plus application-level envelope encryption.
- Point-in-time recovery, and **a restore drill that is actually executed** before go-live. Untested
  backups are not backups.
- Signed PDFs go to object storage with Object Lock / WORM retention, referenced by hash from
  `signatures`.

**Rejected:** MongoDB (no transactions worth the name across the signature+audit write, and the
"document" argument is satisfied by JSONB), SQLite/libSQL for the server (fine for the local
prototype, wrong for multi-user with audit), and an ORM-first design that hides the append-only
constraints — Prisma or Drizzle are fine, but the invariants belong in the database, not the model
layer.

## 2.5 Styling and design system

**Recommendation: Tailwind CSS + Radix UI primitives, tokens in CSS custom properties.**

- Design tokens (`--rail-w`, `--context-w`, `--panel-pad`, colour, spacing, type scale) live in one
  place and are consumed by both Tailwind's theme and plain CSS. In the prototype, the two sidebars
  drifting apart in width and padding was a real defect; a single source of metrics prevents the
  class of bug rather than fixing instances of it.
- Radix (via the shadcn/ui pattern — copy the components into the repo, do not depend on the
  package) gives dialog, popover, menu and tooltip with focus management, `aria-*` wiring and
  scroll locking already correct. The prototype hand-rolled a focus trap that works; owning that
  code across years and browser versions is not a good use of a clinical team's attention.
- **No runtime CSS-in-JS.** On a long document with sticky panels, style recalculation is the
  dominant cost, and atomic CSS keeps the cascade flat.
- **Keep a hand-written print stylesheet** and test it. PDF is a clinical artifact, not a
  screenshot; `@page`, page-break control and header/footer repetition need explicit rules and
  golden-file tests.

**Rejected:** MUI/Ant (opinionated visual language that fights a dense reading-room UI, and heavy
theming overrides), Bootstrap (dated semantics, poor dark-mode story), and styled-components
(runtime cost, and a React Server Component friction that will only grow).

## 2.6 State management

Three kinds of state, three tools — mixing them is what produces the class of bug where a panel
shows another report's numbers.

| State | Tool | Why |
|---|---|---|
| **Server/cache state** (templates, drafts list, audit, user) | **TanStack Query** with persisted cache | Retries, staleness, background refetch, and offline mutation replay are solved problems |
| **Report document** (tokens, field values, dirty flag, undo stack) | **Redux Toolkit + Immer** | A command log gives undo/redo and a free edit trail; time-travel devtools make state bugs reproducible — the prototype's worst bugs were exactly state-lifecycle bugs |
| **Ephemeral UI** (drawer open, active section, popover anchor) | **Zustand** | No ceremony, no provider tree, subscribes per-slice so a keystroke does not repaint the shell |
| **Form-level field editing** | **React Hook Form + Zod** | Validation at the boundary; Zod schemas shared with the API |

Explicit rules that prevent the prototype's bug class:
- Every async subscription (autosave, connectivity, resize) is **owned by a mount token** and checks
  `isCurrent()` before writing to the DOM.
- The document store is the **only** writer of `report.*`; components read, they do not mutate.
- Persistence is a subscriber to the store, not a call sprinkled through event handlers.

## 2.7 The editing engine — the non-obvious choice

**Recommendation: ProseMirror (or Lexical) with a constrained schema, not `contenteditable`.**

This is the highest-leverage technical decision in the app, and the one most likely to be
underestimated.

- A schema that permits only: paragraphs, headings, bold/italic, lists, and **field nodes** (atomic,
  typed, non-editable inline nodes carrying a key). The document cannot become malformed because
  the schema refuses the transaction.
- Deterministic serialisation to the token stream, and therefore to text, HTML, FHIR and PDF, with
  the same `render(parse(x)) === x` invariant that the importer already proves.
- Correct handling of IME, undo/redo, multi-cursor, and — critically — **paste sanitisation**. Users
  paste from Word, from dictation clients, and from other reports. Raw `contenteditable` inherits
  the entire foreign DOM; a schema transforms it into a small set of allowed nodes.
- Field nodes are atomic, so a field cannot be partially deleted or duplicated by a text edit, which
  is currently possible in a DOM-based model.

If the product later needs richer formatting, the schema is extended deliberately rather than
discovered accidentally.

## 2.8 Testing

| Level | Tool | What it must cover |
|---|---|---|
| Unit | **Vitest** | Token model, validation rules, all four exporters, hashing |
| Property-based | **fast-check** | Round-trip invariant across the corpus; depth-aware placeholder scanning |
| Component | **Testing Library** | Field widget behaviour, drawer toggles, focus return |
| E2E | **Playwright**, with projects at 1440/1280/1100/900/768/390 | Every bug that actually mattered in this project was found here |
| Visual/geometry | Playwright screenshots + explicit bounding-box assertions | Drawer overlap was a 21 px geometry defect; only assertions catch it |
| Accessibility | **axe-core** in Playwright + manual screen-reader pass | WCAG 2.2 AA, focus order, `inert` on closed drawers |
| Golden corpus | 427 template fixtures | Any importer or serialiser change that alters output fails the build |
| Load | k6 for API; Lighthouse CI budgets for the shell | 300 KB JS budget, LCP < 2.5 s on a hospital laptop profile |
| Security | `npm audit`, Trivy on images, SAST (Semgrep), dependency pinning | PHI app: supply chain is in scope |

The discipline that matters: **E2E must be CI-blocking and must run in a real browser at real
viewports.** In the prototype, unit tests passed while the review panel was unreachable below
1280 px, the drawer overlapped the top bar, and a stale listener painted the wrong report's save
time. None of those were visible to headless logic tests.

## 2.9 Deployment and operations

- **Containers**, one image per process (`web`, `api`, `worker`), built reproducibly, pinned base
  images, non-root user, read-only root filesystem.
- **Environments**: dev → preview per PR (synthetic patients only) → staging → production. Never
  real PHI outside production.
- **IaC**: Terraform (or Pulumi). Secrets in a managed vault; no secrets in env files in the repo.
- **Supply chain**: SBOM (Syft), image signing (cosign), vulnerability gate (Trivy) — hospitals are
  starting to require this at procurement.
- **Migrations**: forward-only, reviewed, and tested against a production-shaped snapshot; the
  append-only tables get migration tests that assert immutability.
- **Observability**: OpenTelemetry traces, structured logs (pino) with redaction of name/MRN/DOB
  fields by path, uptime and latency SLOs, and **no session replay** on any screen that can show
  PHI.
- **Recovery**: PITR tested quarterly; a documented restore runbook with a named owner.
- **Rollout**: blue/green or canary; the service worker version is part of the release, so a
  rollback must also roll the cache version.

## 2.10 PWA layer

| Concern | Choice | Rationale |
|---|---|---|
| Service worker | **Serwist** (or Workbox) with an explicit allowlist, plus hand-written rules for the PHI boundary | Precaching is solved; the *deny* list is the part you must own |
| Update strategy | Detect a new SW, prompt "Save and reload", never `skipWaiting()` mid-edit | Swapping the shell under a dirty document loses work; the prototype uses immediate claim and that is a latent risk |
| Local store | **Dexie** over IndexedDB | Schema versioning and migrations; raw IDB has no migration story, which becomes painful by release three |
| Storage durability | `navigator.storage.persist()` on first draft, quota monitoring, graceful degradation | Prevents eviction under storage pressure |
| Crypto | WebCrypto; non-extractable AES-GCM keys for offline drafts; **server-side KMS envelope encryption for anything that syncs** | A passphrase-derived key protects a stolen laptop; it does not protect a server |
| Background sync | **Do not rely on the Background Sync API** — use an explicit outbox with TanStack Query persistence and replay on visibility/online | Safari and some managed Chromium policies make Background Sync unreliable; hospital browsers are not yours to choose |
| Manifest | `display: standalone`, `display_override`, shortcuts, `file_handlers` for report bundles, `share_target` where useful | Deep links into library/drafts; opening a `.json` bundle from the file manager |
| Install | MDM/Intune or enterprise browser policy for kiosk-style installs | Radiologists will not "Add to Home Screen" |
| Fonts/assets | Self-hosted, no third-party origins | Offline correctness plus no PHI-adjacent referrer leakage |
| Readiness | Offline-capable matrix documented per feature | "Offline" is a claim that must be enumerated, not a checkbox |

Offline scope decision: **drafts are authorable offline; signing requires connectivity.** A signature
needs server authority, a trusted timestamp and an audit record. Pretending to sign offline is worse
than refusing, because it creates a document with no defensible provenance.

## 2.11 Security and compliance controls (the non-negotiables)

- OIDC + MFA via the IdP; short sessions; step-up auth before sign.
- RBAC: author, sign, co-sign, admin-template, admin-org, auditor-read. Least privilege by default.
- No PHI in logs, no PHI in analytics, no third-party scripts, CSP with no `unsafe-inline`.
- Encryption: TLS 1.2+ in transit, AES-256 at rest (disk + application-level for free text where
  required), keys in a managed KMS with rotation.
- Audit: append-only, hash-chained, tamper-evident, retained per jurisdiction (commonly 7–10 years
  for imaging reports) and exportable to the org's SIEM.
- Retention and deletion: a documented policy, with deletion as a recorded event, not a `DELETE`.
- Dependency policy: pinned versions, automated update PRs, a review gate for new transitive deps.

## 2.12 Explicit anti-recommendations

| Don't | Because |
|---|---|
| Next.js on a frontend PaaS with no BAA | PHI-adjacent request metadata and logs leave your control |
| Client-only PDF as the archival artifact | Font/layout drift across machines; not byte-stable |
| `contenteditable` + DOM scraping as the document model | Caret, IME, undo, paste sanitisation, and atomic fields all break |
| Global required-field rules | A fifth of this corpus would become unsignable |
| `skipWaiting()` in the service worker | Swaps the shell under an open editor |
| Caching API responses "for offline" | Puts PHI in the HTTP cache, outside your encryption story |
| Background Sync as the sync mechanism | Not dependable across the browsers hospitals actually run |
| A document database for signatures and audit | The exact invariants you need are relational |
| Microservices at this size | Operational cost with no scaling benefit |
| Building login | Credential handling is where security programmes fail |

## 2.13 If it stays a prototype

Do not adopt the whole stack for a demo. The proportionate version:

**Vite + React + TypeScript + Dexie + Zustand + Vitest + Playwright, static hosting, no backend.**
That is roughly the current prototype with type safety, a real editor engine, a local-store migration
story and an E2E suite — and it is a weekend of setup rather than a platform project.

## 2.14 Migration path from the current prototype

Ordered so that each step is independently valuable and shippable:

1. **`git init`** + `.gitignore`; commit the corpus as fixtures. (Highest value per minute.)
2. **TypeScript** at the document-model and export boundaries; keep the token grammar unchanged so
   `data/templates.json` stays valid.
3. **Vite** to get a dev server, HMR and a real build; drop the bare static server.
4. **Playwright** with the six viewport projects, plus the geometry assertions that would have
   caught the drawer bug.
5. **Dexie** schema migration for drafts and journal; add `storage.persist()`.
6. **ProseMirror** editor behind a flag, keeping the existing renderer as the serialisation oracle —
   the token stream does not change, so both can write it.
7. **Service worker**: switch to Workbox with an allowlist and deferred activation.
8. **Only then** introduce the API, Postgres and OIDC, starting with reports + signatures + audit.

Steps 1–5 make the prototype honest; 6–7 make it durable; 8 makes it a product.

## 2.15 Open risks to settle before writing production code

| Risk | Why it blocks |
|---|---|
| **Template licensing** (130 RSNA + 127 other-user authored) | Determines whether the corpus can ship at all, and whether exports are derivative works |
| **Regulatory position** | Decides whether a QMS, IEC 62304 process and clinical evaluation are required |
| **EHR/PACS integration scope** | FHIR export vs. HL7 v2 ORU vs. direct DICOM SR changes the backend meaningfully |
| **Signature authority model** | Solo sign vs. resident + attending co-sign changes the data model and the workflow |
| **Retention and jurisdiction** | Sets audit retention, deletion policy and where data may live |
| **Dictation integration** | Microphone vs. third-party client vs. none changes the editor's input handling |

---

## One-paragraph answer

If I were starting today: spend the first week writing down what the software does *not* do, where
PHI can land, and whether the templates may legally ship; spend the next two weeks turning the 427
templates into a hash-frozen, machine-checked schema with a round-trip test in CI, because that
corpus *is* the specification. Then spike the five things that are expensive to discover late —
render performance, PDF determinism, IndexedDB durability, constrained-height layout, crypto UX —
and record a decision for each. Build one vertical slice and put it in front of a radiologist before
adding breadth. Harden against the offline matrix, then validate clinically in shadow mode against a
measured baseline. For the stack: TypeScript throughout, React with Next.js (editor as a client
island, self-hosted — never a PaaS without a BAA), Fastify modular monolith with BullMQ workers,
PostgreSQL with JSONB token streams and WORM object storage for signed PDFs, Tailwind + Radix on CSS
variable tokens, Redux Toolkit for the document with TanStack Query for server state, ProseMirror
for the editor, Vitest + Playwright + axe + fast-check as a CI-blocking gate, Serwist with an
allowlist plus Dexie and WebCrypto for the PWA layer, and OIDC against the hospital's own IdP
because login is the one thing you should never build.

here are some of the things i want from the PWA:
1,EHR/PACS integration is in the scope.
2,Signature authority model: both Solo sign vs plus resident + attending co-sign data model and the workflow
3,Dictation integration bot Microphone and third-party client options
