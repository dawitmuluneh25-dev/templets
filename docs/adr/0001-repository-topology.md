# ADR-0001 — One monorepo, prototype frozen in place

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** project owner; tech lead (role unfilled)
- **Relates to:** production plan §4, §17 (P1); ADR-0004, ADR-0005

## Context

The production system is three processes (web, API, worker) plus a set of libraries that
change together: the token model, the Zod schemas for templates and fields, the validation
rule engine, and the corpus artefact. The repository already contains a working prototype
(`radiology-pwa/`, 17 files, no build step, no dependencies) and the 427-file source corpus
(`alem-reporting-templates/`). Baseline: `main @ 58ae638`, 463 tracked files.

Three facts push the topology decision:

1. **The shared libraries have no independent release cadence.** They are versioned by the
   commit that changes them. Splitting them across repositories means either publishing
   internal packages to a registry or vendoring — both introduce a version negotiation
   problem between code that can only be correct together.
2. **The prototype is evidence, not legacy.** Several behaviours that the rewrite must
   reproduce (three-tier validation, honest save labels, drawer geometry, focus return)
   are only documented fully in that code and in `docs/qa/`. During P2 it is the reference
   implementation to diff against.
3. **The corpus is an input to the build, not a download.** It is parsed into a generated
   artefact, gated by a round-trip test, and seeded into the database (ADR-0004).

## Decision

One repository, pnpm workspaces with Turborepo task orchestration.

```
apps/
  web/          Next.js App Router — library, review queue, admin, audit
  api/          Fastify — REST v1, Zod contracts, OpenAPI generation
  worker/       BullMQ consumers — export, delivery, audit sealing
packages/
  tokens/       document model: parse / serialize / render / hash / migrate   (ADR-0005)
  template-schema/  Zod schemas for templates, sections, typed fields
  validation/   three-tier rule engine, pure, no DOM
  contracts/    API types + OpenAPI source of truth
  ui/           Tailwind tokens + Radix wrappers
  config/       shared tsconfig, eslint, vitest presets
corpus/
  raw/          immutable source .md + templates_index.csv
  provenance.json   per-file author class, licence status, hash            (ADR-0004)
  generated/    templates.json + manifest, committed, regenerated in CI
db/
  migrations/   Drizzle, reviewable SQL
infra/
  compose/      single-node deployment + local stack                        (ADR-0002)
docs/
  adr/          this set
  decisions/    programme-level sign-off artefacts
radiology-pwa/  frozen prototype — reference implementation, not built
```

The prototype **stays where it is** and is not refactored. Its `README.md` gains one line
marking it frozen. It stays runnable with `python -m http.server 8777` so behaviour can be
compared side by side during P2.

## Consequences

**Accepted:**

- The repository holds two generations of code for roughly three months. The root `README.md`
  must state which tree is which, and `CODEOWNERS` should make the distinction visible on
  every PR that touches `radiology-pwa/**`.
- A change to `packages/tokens` rebuilds web, api and worker. Turborepo caching makes this
  cheap locally but it does mean PRs are not independently mergeable across apps — which is
  the point.
- CI cost scales with workspace size. Mitigated by path-filtered jobs; the corpus round-trip
  only runs when `corpus/**` or `packages/tokens/**` changes, plus nightly on `main`.

**Made harder:**

- Onboarding needs a workspace diagram, not a repo tour. That diagram is the tree above.
- A future second product cannot be released on its own cadence without splitting.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Separate repository per app | Cross-cutting changes need coordinated PRs plus package version bumps. At four engineers the coordination cost exceeds the isolation benefit. |
| Production in a new repo; this one becomes an archive | Loses the ability to diff behaviour against the running prototype during P2 — which is exactly the phase that needs it. |
| Prototype moved to `legacy/prototype/` at the same time | Breaks the run instructions and the `../docs/...` links for no functional gain. Moving it is a P2 decision, after parity is measured. |
| Single package, no workspaces | No dependency-direction enforcement. The serialisation boundary in ADR-0005 depends on enforceable package boundaries. |

## Revisit triggers

- P2 exits and parity is measured against the prototype → decide archive vs delete, and
  whether to `git mv` it out of the root.
- A second product or a second delivery team needs an independent release cadence.
- Build times exceed 10 minutes for the median PR with caching warm.
