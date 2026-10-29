# ADR-0009 — The corpus templates are the customer's property

**Status:** Accepted, 2026-10-29
**Deciders:** Project owner
**Supersedes in part:** [ADR-0004](0004-corpus-provenance-and-licensing.md) — the provenance
*classification* stands; the licence *gate* does not.

## Context

ADR-0004 classified every corpus file by authorship and recorded the result, on the argument that
"under what right was this report signed" must be answerable years later. It also implied a gate: the
plan's risk register carried template licensing as R1, the highest-severity item, with the mitigation
being a quarter of replacement authoring, and P1 exit condition E4 was "licence review closed".

That framing treated the corpus as material we might not be allowed to hold. It is not. The templates
were exported from the customer's own reporting platform, by the customer's own users, for the
customer's own use. They are their clinical content, in the same sense as their patient records. A
vendor does not clear a licence to store the customer's data.

The gate had a real cost: it blocked the import, which blocked authoring, which blocked every phase
after P2, on a question that was never ours to answer. Three documents still described that block as
the project's largest risk.

## Decision

**The corpus is user-provided property. Provenance is recorded; licensing is not enforced.**

1. Imported templates are written with `licence_status = 'user_provided'` — a fourth value (0006),
   distinct from `cleared` and `restricted`, because it says what is true: the basis is custody, not
   a licence we hold.
2. `provenance` (the JSONB column) keeps the classification from ADR-0004 — `org_authored`,
   `third_party`, `unattributed`, `unknown` — plus the source path and guid. It answers "where did
   this text come from", which is still worth answering.
3. **No code path refuses a template, a report, or a deployment on the basis of provenance or licence
   status.** There is no such check to remove, and adding one is a regression against this ADR.
4. `restricted` and `denied` remain valid values for material acquired some other way — a licensed
   template library, for instance. They are labels, and nothing enforces them at runtime.

## Consequences

- **Import is unblocked.** P1 exit condition E4 becomes a record-keeping task rather than a
  precondition: the provenance artefact already exists (`corpus/provenance.json`), and it is now the
  whole of the deliverable.
- **R1 is reclassified** from "can stop the project" to "cannot stop the project; may constrain
  redistribution". The mitigation (org-authored replacement templates) stays on the shelf, unwritten,
  because nothing requires it.
- **Redistribution is not decided here.** If these templates were ever to be shipped to a *different*
  customer, that is a new question and a new ADR. Custody by the organisation that authored the text
  does not carry to a third party, and `third_party` entries in the provenance artefact are exactly
  the set that would need looking at first.
- **A challenged template is deprecated, not unwound.** `template.status = 'deprecated'` stops it
  being offered. Reports already signed on it keep their pinned, immutable `template_version`, because
  the alternative — rewriting the text a signature attests to — is the failure the whole evidence
  model exists to prevent.

## Revisit trigger

A customer asking to *export* templates to another organisation, or a sales motion involving
templates as a deliverable. Neither is in scope for v1.
