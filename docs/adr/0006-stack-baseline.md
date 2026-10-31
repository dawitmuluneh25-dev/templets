# ADR-0006 — Stack baseline, pinned and ratified

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** project owner; tech lead (role unfilled)
- **Relates to:** production plan §4 (stack), §12 (infrastructure), §18.1 A1–A8; ADR-0001, ADR-0003, ADR-0005

## Context

Production plan §4 chose a stack. A table in a plan is a preference; it becomes a decision only
when something can fail because of it. Three properties of this product make the choice
load-bearing rather than stylistic:

1. **The document is evidence.** A signature hashes content (ADR-0005). Anything that can change
   a rendered byte — an unpinned renderer, a CDN-delivered font, a floating dependency — can
   change what a signature appears to attest.
2. **The deployment is single-tenant in a customer VPC** (ADR-0002). Whatever is chosen must run
   in a hospital's network, behind their egress rules, without a vendor control plane. That
   excludes a large part of the modern default toolchain before any preference is expressed.
3. **The team is small and the domain is not.** One or two engineers will carry the build. Every
   layer that requires its own operational knowledge is a layer that will be half-maintained.

The P0 pack lists this as entry condition E2, partial, and the register listed 0006 as not
written. Writing it before the first dependency is installed is the point: after that, the stack
is whatever the lockfile drifted into.

## Decision

**The stack in production plan §4 is ratified as the baseline, with the qualifications below.**
It is not re-derived here; it is adopted, and the qualifications are what this ADR adds.

### 1. Ratified choices, by the property that justifies them

| Property the product needs | Choice | Why this and not a preference |
|---|---|---|
| One type system across the wire | TypeScript strict + `noUncheckedIndexedAccess` | The token model is a discriminated union; the compiler is the cheapest validator available and it runs on every keystroke in CI |
| Server rendering for library, admin, audit | React + Next.js App Router, self-hosted | Those screens are lists and tables that should not ship as a client app; the editor is a client island inside it |
| A document model that survives replacement | ProseMirror with a constrained schema | Atomic field nodes, IME correctness, paste sanitisation, deterministic serialisation. The constraint matters more than the library |
| Accessible primitives without inventing them | Tailwind + Radix on CSS-variable tokens | One source of spacing and width truth; Radix supplies the focus and keyboard behaviour that is expensive to get right |
| Three kinds of state, three failure modes | Redux Toolkit (document) · TanStack Query (server) · Zustand (UI) | The command log is the undo stack *and* the edit trail; conflating it with server cache is how audit gaps appear |
| Validation enforced once | React Hook Form + Zod, shared client/server | The same schema produces the form, the API validator and the OpenAPI document |
| A schema-first boundary | Fastify + Zod, OpenAPI 3.1 generated | Generated, never hand-kept (plan §8.1) |
| Work that must not block a request | BullMQ + Redis | Export, delivery and audit sealing are queued by definition |
| Transactions, constraints, on-prem maturity | PostgreSQL + JSONB, RLS | Multi-table transaction for sign + audit; RLS is the tenancy mechanism (ADR-0003) |
| Invariants in the database, reviewable as SQL | Drizzle | Migrations are readable SQL in review, not a generated diff to be trusted |
| WORM for signed artefacts | S3 Object Lock, MinIO on-prem | An archive that can be deleted is not an archive |
| Never build credentials | OIDC against the hospital IdP; Auth.js for the web session | Joiner/leaver is already solved by the customer; our building it would be a second, worse identity system |
| Byte-stable archive | Server-side PDF renderer in a pinned container | Font drift in a signed artefact is a correctness defect, not cosmetics |
| PHI stays in boundary | ASR via an internal relay to a BAA-covered or self-hosted engine | The vendor never sees the browser; the relay is swappable |
| Offline shell that never caches PHI | Serwist/Workbox with an explicit allowlist, Dexie, WebCrypto | The allowlist is the security control; a hand-rolled SW re-implements precache and gets it wrong |
| Portability between cloud-with-BAA and on-prem | Terraform + Docker + Kubernetes or ECS | Two deployment profiles were promised (ADR-0002); that promise needs an abstraction that is not a vendor's |
| Provenance procurement will ask for | cosign + Syft SBOM + Trivy in CI | Increasingly a contractual requirement, not a nicety |
| PHI-safe telemetry by construction | OpenTelemetry + pino with redaction | Redaction as configuration is a toggle someone will turn off |

### 2. Rejections are part of the decision

The following are rejected for this product, not merely deprioritised. A proposal to adopt one
requires a superseding ADR:

- any frontend PaaS without a BAA covering PHI workloads;
- third-party CDNs or web-font hosts for the application shell;
- session replay on any screen that can display PHI;
- a document database as the system of record;
- microservices at this team size;
- building authentication.

### 3. Pinning rules that make "baseline" enforceable

- **Node 22 LTS**, pinned in `.nvmrc` and in CI (`node-version-file`). One runtime, one version.
- **pnpm with a committed lockfile.** `--frozen-lockfile` in CI; a lockfile change is a reviewed
  change.
- **Exact versions for the archive path.** The PDF renderer container is referenced by digest,
  not tag. Fonts are vendored, never fetched at render time.
- **No floating ranges in `dependencies`.** `^` is permitted in `devDependencies` where a broken
  minor is recoverable by a revert; it is not permitted where the artefact is signed.
- **TypeScript 6.0.3, not 7.x.** TypeScript 7 (the native compiler) is released, and
  `typescript-eslint` refuses to load against it — which does not fail the lint step, it removes
  it. Pinned to the last supported major until typescript-eslint ships TS 7 support. This is
  exactly the class of decision that a lockfile would otherwise make silently.
- **The stack is asserted, not assumed.** `pnpm lint`/`typecheck`/`test`/`build` on every PR is
  the mechanism; a documented stack that CI does not exercise is a wish.

### 4. What this ADR explicitly does not decide

- The cloud vendor and whether it offers a BAA (procurement; gated on the signed agreement —
  ADR-0002 already records vendor as open).
- The ASR engine (plan D6) and the PDF engine choice between headless Chromium and Typst, both
  of which need a spike against real reports before they are pinned.
- The reusable-UI library boundary beyond "Radix primitives live in `packages/ui`".
- The test-count and coverage thresholds, which belong to §10's test strategy, not here.

## Consequences

**Accepted:**

- **A single runtime for web and API.** Next.js App Router for the shell means the API cannot be
  a separate language or a polyglot boundary. That is a constraint on hiring and a simplification
  of deployment; both are intended.
- **ProseMirror is expensive to learn.** The constrained schema buys determinism and costs weeks
  of ramp-up. The alternative (Lexical) trades maturity of schema tooling for a smaller API, and
  schema tooling is exactly what this product leans on.
- **Drizzle means writing SQL.** That is the reason it was chosen and it will be the reason
  someone proposes Prisma in month four.
- **A pinned PDF container is operationally awkward.** Digest-pinned images need a rebuild path
  for CVEs that does not change output bytes. That is a real recurring cost.
- **Turborepo and pnpm add a layer** between the engineer and the compiler. Paid for by caching
  and by workspace boundaries that map onto the ADRs.

**Made harder:**

- **No CDN, no font host, no PaaS convenience.** Shell assets are served by us, from the same
  origin, including fonts. That is slower to set up and is the reason the offline cache can be
  trustworthy.
- **Every external service needs a BAA before it can hold PHI.** This shrinks the vendor list
  before any technical evaluation starts, and will occasionally lose a tool that was otherwise
  the best fit.
- **Kubernetes-or-ECS portability is a tax** paid on every infrastructure change, in exchange for
  the on-prem profile that at least one customer will require.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Vite + React SPA behind nginx as the primary shape | Kept as the documented fallback where no Node runtime is permitted (plan §4). It cannot serve library/admin/audit with SSR, so it is a fallback, not the baseline. |
| NestJS for the API | Structure worth its weight above roughly four engineers. Below that it is ceremony around a router. Revisit trigger, not a rejection in principle. |
| Prisma instead of Drizzle | Fine ORM; SQL is less transparent in review, and this schema's value is in its constraints and policies. |
| Lexical instead of ProseMirror | Smaller and pleasant, weaker schema tooling; the constrained schema is the requirement. |
| Temporal instead of BullMQ | Correct at multi-region scale, overkill at this one. Revisit if jobs become cross-region or long-lived workflows. |
| MongoDB or another document store | Rejected in plan §4 for a specific reason: no reliable multi-table transaction for sign + audit. The token stream is a document, but the *evidence* around it is relational. |
| Tailwind alone, hand-rolled primitives | Accessibility behaviour is not a weekend task. Radix is the cheaper correct answer. |
| Managed auth (hosted identity) | Adds a third party inside the PHI boundary and duplicates the customer's IdP. |

## Revisit triggers

- **The team exceeds four engineers** → revisit Fastify vs NestJS on the API, and whether
  `packages/*` should publish internally rather than be consumed from source.
- **A customer forbids a Node runtime** → the Vite SPA fallback in plan §4 becomes a second
  supported shape, which is a supported-configuration decision, not a code decision.
- **The editor is replaced** → ADR-0005 already insulates the archive; only the view layer
  changes. If a replacement cannot express the token AST, that is a token-model ADR.
- **Multi-region becomes a requirement** → revisit the job system and the Redis role.
- **`typescript-eslint` supports TypeScript 7** → move to 7 in one commit, with the lint gate
  verified as still running rather than merely present.
- **A signed artefact ever renders differently from its signature-time bytes** → this is a
  defect in the pinning rules in §3, not a bug in a renderer, and this ADR is wrong until fixed.
