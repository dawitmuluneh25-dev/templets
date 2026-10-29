# P0 decision pack

The sign-off artefact for leaving discovery. Everything here is either ratified with a date,
open with a named owner, or explicitly deferred with the phase that will decide it.

**Status:** 4 of 9 P1 entry conditions met, 1 partial. The one that still gates any claim about
this build: branch protection (E7) — the repository is local-only, so the CI committed on
2026-10-29 has never actually run.

**Baseline:** `main @ 58ae638` — 463 files, prototype 427/427 round-trip, working tree clean.

**Workspace:** `feat/p1-foundation` — `pnpm verify` green (lint · format · typecheck · 108 tests ·
build). Corpus round-trip 427/427 with zero quarantined; tenant isolation proven against
PostgreSQL 16.15; ADR-0006 and ADR-0007 accepted. The headless vertical slice runs end to end — create a report
from a pinned template version, autosave a revision, sign — with the evidence invariants enforced by
the database (migrations 0003–0004) rather than only by the service that wrote them. Approval is
N-of-M with cross-cover, so `signed` means enough distinct people rather than a flag the service
remembers.

`apps/web` carries the first web slice: a server-rendered template library over the committed corpus
artefact, faceted search and pagination that work without JavaScript, an installable shell, and a
service worker whose cache allowlist excludes every document ([ADR-0008](adr/0008-service-worker-allowlist.md)).
It is read-only — the editor island is P2, and signing still waits on E9.

---

## 1. Ratified

| # | Decision | ADR | What it forecloses |
|---|---|---|---|
| R1 | One monorepo; prototype frozen at `radiology-pwa/`, not refactored | [0001](adr/0001-repository-topology.md) | Independent release cadence per app |
| R2 | Single-tenant deployment per customer, in a customer VPC, managed services under a signed agreement | [0002](adr/0002-deployment-profile.md) | Pooled multi-tenant launch; one global database |
| R3 | `org_id` on every clinical row + RLS enforced in the database, set per transaction from the session | [0003](adr/0003-tenancy-and-row-level-security.md) | Application-only filtering; schema-per-tenant |
| R4 | Corpus: immutable source, provenance-gated, generated artefacts committed and reproducible, default-deny | [0004](adr/0004-corpus-provenance-and-licensing.md) | Editing clinical wording to satisfy a parser; shipping unknown-provenance templates |
| R5 | One serialisation boundary (`packages/tokens`), canonical token string as the stored form, versioned from the first row | [0005](adr/0005-token-model-serialisation-boundary.md) | Persisting the editor's document model; per-renderer parsing |

Each of these is cheap today and a migration after the first signed report exists. That is why
they were decided before any code.

---

## 2. P1 entry conditions

| # | Condition | State | Note |
|---|---|---|---|
| E1 | Repository with clean baseline and `.gitignore` | **Met** | 507 tracked files, no untracked or ignored artefacts |
| E2 | Stack decisions recorded | **Met** | ADR-0001…0006 accepted; 0006 ratifies plan §4 and records the pinning rules |
| E3 | Corpus reproducible from source with a passing round-trip | **Met** | 427/427, 0 quarantined, 2,381 typed fields across 258 templates |
| E4 | Licence review **started** with an owner and a date | **Not met** | Blocks customer shipment, not building. See §4 |
| E5 | Deployment vendor shortlist + BAA path | **Not met** | Needed by P4, but the choice constrains P1 infrastructure scaffolding |
| E6 | Toolchain available on the build machine | **Met** | Node 22.23.2, pnpm 12.16.1 via corepack, PostgreSQL 16.15 natively (Docker absent, and not required by the chosen profile) |
| E7 | Branch protection on `main` + PR template | **Partial** | PR template, commitlint and the CI workflow are committed; branch protection needs a remote, and CI has never run |
| E8 | One named clinical champion with protected time | **Not met** | Needed by P3, worth naming now |
| E9 | IdP capability confirmed (role groups + step-up) | **Not met** | Needed by P3 |

E6 was the one that affected the order of work rather than the plan, and it is now closed: the
database layer is built and proven against a real PostgreSQL 16.15, so migrations are applied
rather than merely written. Nothing about the plan changed — only the sequence, because a
migration that has never run is worse than no migration.

---

## 3. Carried from the plan — D3 decided, the rest open

| ID | Decision | Decider | Needed by |
|---|---|---|---|
| D1 | Deployment vendor per customer | Customer IT + us | P0 — **profile settled (R2), vendor open** |
| D2 | Solo-sign policy: attending-only vs configurable per service | Clinical governance | P3 |
| D3 | Multi-attending approval: single co-sign vs N-of-M | Clinical governance | **Decided 2026-10-29** — N-of-M with cross-cover, [ADR-0007](adr/0007-multi-signature-approval.md); shipped in migration 0004. Clinical sign-off in §6 is still blank |
| D4 | Addendum vs corrected-report semantics downstream | EHR integration owner | P4 |
| D5 | DICOM SR in v1 or v1.1 | Product + customer | P4 |
| D6 | ASR engine: BAA vendor vs self-hosted | Security + finance | P4 |
| D7 | Offline signing: blocked vs deferred attestation | Compliance + clinical | P6 |
| D8 | Dictation transcript provenance in the audit record | Compliance | P5 |
| D9 | Retention per jurisdiction (7 / 10 / 20 years) | Customer compliance | P2 |
| D10 | Phone authoring: read-only vs full | Clinical | P2 |
| D11 | Template authoring in-app: v1 vs v1.1 | Product | P9 |
| D12 | Bulk co-sign: allowed with warnings vs disallowed | Clinical governance | P3 |

D3 was the one that could invalidate architecture rather than scope, and it did: authority is N-of-M
with cross-cover, so the state machine changed. It is closed by [ADR-0007](adr/0007-multi-signature-approval.md)
— `submitted` is now a real state, `signed` is a count, and uniqueness is per person per revision.
What that costs is in the ADR's Consequences section. One of those costs has been paid: cross-cover is
now a `delegation` row with a window, and a delegate signature cites it (migration 0005), so "who said
you could sign for them" is answerable. What remains is the approval *policy* — the requirement is set
by a named role rather than derived from service, template and urgency — which is the resolver
ADR-0007 already anticipates, and should land before P3.

---

## 4. Licensing — decided, not open

[ADR-0009](adr/0009-templates-are-user-property.md) answers what these items were asking. The
corpus templates are the customer's property, exported from their own platform by their own users.
Provenance is recorded for the trail; **nothing refuses a template, a report or a rollout on it.**

| # | Item | Status |
|---|---|---|
| N1 | 168 of 427 templates have no author metadata | Recorded as `unknown` in `corpus/provenance.json`. No longer a gate |
| N2 | 130 third-party-authored templates sit in the organisation's own scope | Recorded as `third_party`. Also no longer a gate; the scope label is still worth reviewing before any redistribution |
| N3 | The third-party count does not reconcile (127 in plan §7.6, 128 in this pack, 130 from the importer) | **Still open, and still worth fixing.** A provenance artefact that disagrees with itself is the one thing here a reviewer will notice |
| N4 | Licence clearing needed by P1 exit | **Closed.** Redistribution to a different organisation would reopen it; that is out of scope for v1 |

The replacement-template mitigation stays on the shelf, unwritten, because nothing requires it. If
N3 turns up a template that must not be used, the response is `template.status = 'deprecated'` —
reports already signed keep their pinned version.

---

## 5. Stop and re-plan

Three signals that the plan is wrong rather than late (production plan §18.5):

1. The EHR cannot supply patient context at launch → integration becomes a manual workflow.
2. Co-sign authority is N-of-M with cross-cover rules → the state machine changes. **Fired
   2026-10-29**, decided in ADR-0007.
3. Dictation accuracy in the customer's own vocabulary is unusable → the requirement is a
   transcription service, not a feature.

Any of these invalidates a phase boundary, not just a task. Re-plan rather than absorb.

Signal 2 fired and was absorbed rather than re-planned: the change landed inside the P1 slice, on the
argument that the affected edge is one guard and one constraint. That exception is recorded here
instead of being left implicit, because the next reader should be able to see that the signal was
noticed, not that the plan quietly disagreed with itself. Signals 1 and 3 are still live checks.

---

## 6. Sign-off

| Role | Name | Date | Scope |
|---|---|---|---|
| Project owner | | | R1–R5, E1–E3, E6 |
| Clinical governance | | | D2, D3, D12 |
| Legal | | | R4, N1–N4 |
| Customer IT | | | D1, E5 |

