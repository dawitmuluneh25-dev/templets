# Architecture decision records

One file per decision that is expensive to reverse. The test for "does this need an ADR" is
not importance, it is **cost of being wrong later**: schema shape, module boundaries, what
gets stored, where the tenancy line sits.

## Register

| ADR | Decision | Status | Date |
|---|---|---|---|
| [0001](0001-repository-topology.md) | One monorepo, prototype frozen in place | Accepted | 2026-10-29 |
| [0002](0002-deployment-profile.md) | Single-tenant deployment in a customer VPC | Accepted (vendor open) | 2026-10-29 |
| [0003](0003-tenancy-and-row-level-security.md) | `org_id` on every clinical row, RLS in the database | Accepted | 2026-10-29 |
| [0004](0004-corpus-provenance-and-licensing.md) | Corpus: default-deny, immutable source, reviewable artefacts | Accepted (licence clearing pending) | 2026-10-29 |
| [0005](0005-token-model-serialisation-boundary.md) | One serialisation boundary, versioned from the first row | Accepted | 2026-10-29 |
| [0006](0006-stack-baseline.md) | Stack baseline ratified, pinned; rejections are decisions | Accepted | 2026-10-29 |

## Format

Five sections, in this order: Context, Decision, Consequences, Alternatives considered,
Revisit triggers. A decision with no stated cost is a wish; the Consequences section exists to
say what gets harder, not to restate the benefits.

`Status` is one of: `Proposed`, `Accepted`, `Superseded by ADR-nnnn`, `Deprecated`.

## Rules

- ADRs are append-only. To change a decision, write a new ADR that supersedes the old one and
  leave the old one in place with its status updated. Editing history to look consistent is
  how a decision log stops being evidence.
- Anything that contradicts an accepted ADR is a bug until a superseding ADR merges.
- Enforcement belongs in CI where possible: an ADR nobody can violate by accident is worth
  more than one that is merely cited.

## Related

- [Production plan](../Radiology-Reporting-PWA-Production-Plan.md) — §4 stack, §6 data model,
  §12 infrastructure, §17 roadmap, §18 open decisions
- [Greenfield and stack rationale](../Radiology-PWA-Architecture-and-Stack-Plan.md)
- [P0 decision pack](../P0-Decision-Pack.md) — what is ratified, what is still open
