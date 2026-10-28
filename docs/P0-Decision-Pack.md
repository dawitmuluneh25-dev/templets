# P0 decision pack

The sign-off artefact for leaving discovery. Everything here is either ratified with a date,
open with a named owner, or explicitly deferred with the phase that will decide it.

**Status:** 4 of 9 P1 entry conditions met, 1 partial. The one that still gates any claim about
this build: branch protection (E7) — the repository is local-only, so the CI committed on
2026-10-29 has never actually run.

**Baseline:** `main @ 58ae638` — 463 files, prototype 427/427 round-trip, working tree clean.

**Workspace:** `feat/p1-foundation` — `pnpm verify` green (lint · format · typecheck · 40 tests ·
build). Corpus round-trip 427/427 with zero quarantined; tenant isolation proven against
PostgreSQL 16.15; ADR-0006 accepted.

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

## 3. Open — carried from the plan, unchanged

| ID | Decision | Decider | Needed by |
|---|---|---|---|
| D1 | Deployment vendor per customer | Customer IT + us | P0 — **profile settled (R2), vendor open** |
| D2 | Solo-sign policy: attending-only vs configurable per service | Clinical governance | P3 |
| D3 | Multi-attending approval: single co-sign vs N-of-M | Clinical governance | P3 |
| D4 | Addendum vs corrected-report semantics downstream | EHR integration owner | P4 |
| D5 | DICOM SR in v1 or v1.1 | Product + customer | P4 |
| D6 | ASR engine: BAA vendor vs self-hosted | Security + finance | P4 |
| D7 | Offline signing: blocked vs deferred attestation | Compliance + clinical | P6 |
| D8 | Dictation transcript provenance in the audit record | Compliance | P5 |
| D9 | Retention per jurisdiction (7 / 10 / 20 years) | Customer compliance | P2 |
| D10 | Phone authoring: read-only vs full | Clinical | P2 |
| D11 | Template authoring in-app: v1 vs v1.1 | Product | P9 |
| D12 | Bulk co-sign: allowed with warnings vs disallowed | Clinical governance | P3 |

D3 is the one that can invalidate architecture rather than scope: if authority is N-of-M with
cross-cover rules, the state machine changes, not a query. Confirm before P3 starts.

---

## 4. Open — surfaced by the ADR work (new)

| # | Item | Why it matters | Owner |
|---|---|---|---|
| N1 | **168 of 427 templates have no author metadata.** Provenance must come from platform account records, not the export | Cannot classify them as `cleared` without evidence; they default to restricted, which is 39% of the corpus | Product + legal |
| N2 | **123 third-party-authored templates sit in the organisation's own scope** | Highest-risk class: the scope label asserts ownership the metadata contradicts | Legal |
| N3 | Third-party count is 128 opaque ids, not the 127 stated in plan §7.6 | A legal review should not be quoted a number that does not reconcile | Product |
| N4 | Licence clearing needed by **P1 exit**, per §18.3 | It is the only dependency that can make the whole corpus unusable after the build is finished | Legal |

If N1 and N2 resolve badly, the mitigation is org-authored replacement templates — currently
P9 scope. **That is a schedule risk, not a technical one**, and it should be priced before P4,
because moving template authoring forward is a quarter, not a sprint.

---

## 5. Stop and re-plan

Three signals that the plan is wrong rather than late (production plan §18.5):

1. The EHR cannot supply patient context at launch → integration becomes a manual workflow.
2. Co-sign authority is N-of-M with cross-cover rules → the state machine changes.
3. Dictation accuracy in the customer's own vocabulary is unusable → the requirement is a
   transcription service, not a feature.

Any of these invalidates a phase boundary, not just a task. Re-plan rather than absorb.

---

## 6. Sign-off

| Role | Name | Date | Scope |
|---|---|---|---|
| Project owner | | | R1–R5, E1–E3, E6 |
| Clinical governance | | | D2, D3, D12 |
| Legal | | | R4, N1–N4 |
| Customer IT | | | D1, E5 |

