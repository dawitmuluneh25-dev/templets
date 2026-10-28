# ADR-0004 — Corpus provenance: default-deny, immutable source, reviewable artefacts

- **Status:** Accepted (engineering position); licence clearing is **not** resolved by this ADR
- **Date:** 2026-10-29
- **Deciders:** project owner; legal (pending)
- **Relates to:** production plan §4, §7.6, §18.1 (A4), §18.2 (R1), §18.3; ADR-0001

## Context

The corpus is 427 files and it is two things at once: the clinical content radiologists will
use, and the specification for validation — requiredness is per template, because 35 templates
have no IMPRESSION section and 10 have no FINDINGS. It cannot be normalised away or
paraphrased without breaking the second role.

Two hazards have to be designed out, not documented away:

1. **Shipping content we have no right to redistribute.**
2. **Silently editing clinical wording to satisfy a parser.** A "fix" that changes what a
   template says is a clinical change made by an engineer, in a diff nobody reads.

### Measured provenance (from `templates_manifest.json`, 2026-10-29)

| `author` field | `scope` | Files |
|---|---|---|
| empty | AlemHealth | 167 |
| empty | Publicly Shared | 1 |
| opaque `auth0\|…` id (another platform user) | AlemHealth | 123 |
| opaque `auth0\|…` id (another platform user) | Publicly Shared | 5 |
| `RSNA` | Publicly Shared | 130 |
| `alemhealth` (literal string) | Publicly Shared | 1 |
| | **Total** | **427** |

Three things follow from this table, and they change the shape of the licensing question:

- **123 third-party-authored files sit inside the organisation's own scope.** They look local
  and are not. This is the highest-risk class precisely because the scope label asserts an
  ownership the metadata contradicts.
- **168 files have no author at all.** Their provenance cannot be recovered from the export;
  it has to come from platform account records (who uploaded each GUID, when, from where).
  Until that exists, "no author" means "unknown", and unknown must not be treated as ours.
- **The plan's §7.6 figure of 127 third-party files is one lower than the 128 opaque ids
  measured here**, depending on whether the literal `alemhealth` author is counted. Reconcile
  before a legal review quotes the number.

## Decision

1. **Source is immutable.** `corpus/raw/**` is read-only input. `corpus/provenance.json`
   records, per file: `sha256`, `relpath`, `guid`, `author_raw`, `author_class`
   (`org` \| `rsna` \| `third-party` \| `unknown`), `scope`, `evidence` (how the class was
   determined), `licence_status` (`cleared` \| `pending` \| `restricted`), `redistributable`.
2. **Import never edits clinical text.** Parsing defects are handled by the scanner
   (depth-aware bracket matching, literal `\u00a0` decoding) and recorded in
   `corpus/known-defects.md`. A file that cannot round-trip is **quarantined and fails CI** —
   a build break, visible in the PR, not a runtime surprise and never a silent patch.
3. **Generated artefacts are committed and reproducible.** `corpus/generated/**` is
   regenerated deterministically; CI asserts the regeneration is byte-identical. Hand-editing
   generated output fails the build. Committing it is what makes a corpus change reviewable
   as a diff.
4. **Licence is data, not a code branch.** `template.provenance`, `template.licence_status`
   and a per-tenant `enabled_templates` projection. Restricted templates are **present but
   disabled**, not absent — clearing a licence is then a flag with an audit record, and the
   system can answer "under what right was this report signed".
5. **Default deny.** `author_class = unknown` resolves to `restricted`. Production enables
   `cleared` only; `staging` may load the full corpus for fidelity testing because it holds
   synthetic data only.

The licence position is a **per-deployment** property, so a customer who brings their own
corpus or their own rights enables theirs through the same projection. No forked corpus.

## Consequences

**Accepted:**

- The legal dependency now has an engineering shape and a deadline: needed by P1 exit
  (§18.3). It blocks shipping to a customer, not building.
- The review is larger than "are the RSNA ones acceptable": 168 files need account-level
  evidence before they can be classified at all. Scope this before promising a date.
- If legal denies redistribution of the third-party classes, the replacement path is
  org-authored templates, which the plan places at P9. **That ordering would move earlier**
  and is a schedule risk worth naming now rather than at P8.

**Made harder:**

- Every corpus change becomes a two-part diff (source + generated artefact). Correct, but it
  needs a `corpus-change` PR label and a reviewer who reads clinically.
- Someone will eventually want to fix a typo in a template. That is a new version
  (`template_version`), not an edit — the immutability is the feature.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Strip every non-org template at import | Destroys the specification and the fidelity test, and removes 130 clinically useful RSNA templates on a suspicion. |
| Ship everything under the platform's terms of service | An unresolved legal position is not a licence. Unacceptable for a product holding PHI. |
| Rewrite wording to avoid the licensing question | Clinically indefensible: an engineer silently changing what a radiology template says. |
| Fork the corpus per customer | Defeats shared curation and doubles the fidelity surface. The projection table achieves isolation without a fork. |

## Revisit triggers

- Legal opinion lands → set `licence_status` per class and re-run enablement.
- A customer supplies their own corpus → the projection path already supports it; confirm
  their provenance evidence meets the same bar.
- A `restricted` template is requested for clinical use → this is the escalation that decides
  whether template authoring moves out of P9.
