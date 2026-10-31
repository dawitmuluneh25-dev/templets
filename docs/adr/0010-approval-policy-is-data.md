# ADR-0010 — How many signatures a report needs is a policy row, not a request field

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** project owner (the count itself remains a clinical-governance decision; this ADR
  decides only where it is recorded)
- **Relates to:** ADR-0007 (N-of-M approval, and its third revisit trigger), ADR-0003 (RLS),
  ADR-0005 (the stored form of a report); D3 in the P0 pack

## Context

ADR-0007 gave a report a number — `approvals_required`, 1 to 5 — and put it on the create
request body. The only thing between an author and a lower bar was a role check in the service:
above 1, the caller had to hold `clinical_lead`. That check answers one question, *may this
person decide*, and leaves the other one, *what was decided*, with nowhere to live.

The consequences are not hypothetical:

1. **The same exam can be barred differently by two people and neither is wrong.** Two
   radiologists creating a report from the same template, in the same hour, can require one
   signature and three, because each typed a number. Nothing in the database can object: the
   column is `check (1..5)` and the trigger enforces the count it is given.
2. **A policy cannot be stated once.** "Every CT head needs two attendings" is a sentence
   somebody has to remember and re-enter per report. Rules that live in memory drift, and the
   drift is invisible until an auditor samples two reports of the same kind.
3. **The trail records the outcome, not the rule.** `report.approvals_required` says what this
   report required. It cannot say whether that matched what the department wanted, because the
   department's position was never anything but a series of individual keystrokes.
4. **The guard rests on a placeholder.** `clinical_lead` is a role name no IdP supplies yet
   (E9). Until it does, the gate is only as real as whatever creates users — which is to say,
   in development, it is a string in a header.

The third point is what makes this expensive to defer. A report is evidence. Evidence that
records a decision without recording the rule behind it cannot answer the only question asked of
it later: was this signed the way it was supposed to be?

## Decision

**The number comes from a tenant-scoped rule table. A report cites the rule it was created
under. A create with no rule behind it is refused.**

Concretely:

- **`approval_policy`** — `(org_id, template_id?, modality?, approvals_required, rationale,
  created_by_user_id, created_at)`. A null key is "any"; both null is the organisation default.
  Append-only: the application may insert and select, nothing else.
- **Resolution order is total and documented.** Specificity first — a template rule (2) beats a
  modality rule (1), which beats the organisation default (0) — then the newest row for that
  key, then `id` so that two rows written in the same instant still have a defined winner. The
  specific rule wins because a specific rule is a deliberate exception to a general one; if the
  general rule won, writing an exception would be impossible.
- **`created_at` is `clock_timestamp()`.** Inside one transaction `now()` is fixed, so two rules
  written together would have the same timestamp and "newest wins" would silently fall back to a
  random UUID.
- **The create body has no `approvals_required`.** Resolution happens inside the creating
  transaction, the number is copied onto `report.approvals_required`, the rule's id onto
  `report.approval_policy_id`, and both into the `report.created` audit event.
- **No rule is an error, not a default.** `409 no_approval_policy`. Falling back to 1 would
  reproduce the hole this closes, in the one state where nobody would notice it.
- **Only a `clinical_lead` may write a rule** — refused with `403` in the service, and refused by
  a trigger for a row written past the service.
- **The database refuses two things the service also refuses**: a report with no
  `approval_policy_id`, and a report whose `approvals_required` disagrees with the rule it cites.
  Without the second check the column would be decoration — cite the rule that says 1, carry 3,
  and the 0004 trigger would enforce the 3 as though a policy had asked for it.

## Consequences

**Accepted:**

- **A fresh deployment cannot author a report until someone writes a rule.** This is the same
  shape as signing returning `503` without a step-up verifier, and it is deliberate: a system
  that picks the bar for you is a system that has made a governance decision on your behalf.
  The cost is a setup step that can be forgotten, and an error message that has to say what to do.
- **Rules are snapshotted, never referenced for meaning.** Changing a rule does not re-bar an
  existing report, and the audit event keeps both the number and the rule id. The cost is that
  "what does the rule say now" and "what did it say when this report was created" are two
  different queries, and any report that conflates them will be wrong in a way that looks right.
- **Rules cannot be retired, only superseded.** Append-only means a key can be given a new
  number and never removed. `approvals_required = 1` is how "no second signature" is recorded,
  and recording it is the point: an absent rule and a rule that says one are different states.
  The cost is that a key accumulates rows, which is the price of the table being usable as
  evidence.
- **One more table, one more endpoint, one more way for the create path to fail.**
- **The authority did not disappear, it moved.** Writing a rule still depends on `clinical_lead`,
  which is still a placeholder until E9. What changed is that the placeholder now guards a
  durable object rather than a keystroke: when E9 lands, the rules already written keep their
  meaning, whereas numbers typed under a header-identity gate would not have.

**Made harder:**

- **Urgency as a dimension.** ADR-0007 anticipated template + service + urgency. A study in this
  schema carries no urgency, so that axis cannot be expressed yet.
- **A service axis distinct from modality.** A template is a service's output, so a template rule
  already says "this service requires two". Adding a third axis that usually agrees with the
  first is two ways to express one decision.
- **Per-report exceptions.** There is deliberately no field for one. An exception is a decision
  with a reason, and it needs its own row, not a value that overrides the rule for one report and
  leaves no trace of why.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Keep the field, validate it against the policy | Two sources for one number. The day they disagree, every reader has to know which one wins, and the write path that produced the disagreement is the one that is wrong. |
| Default to 1 when no rule matches | Reopens the exact hole in the one state nobody tests — a fresh deployment. The failure is silent by construction: solo sign always succeeds. |
| Rules in a config file (YAML/env) | No tenancy, no per-tenant override, no audit of who changed it, and no way to change a rule without a deploy. The rule would be less accountable than the report. |
| A `clinical_lead` override on the create body | Turns the policy into an advisory default with an unaudited exception path, which is where the original problem came from. |
| Retiring or expiring a rule | Append-only is what makes the table evidence. Supersession by a newer row covers the need; an editable rule is a rule whose history nobody can rely on. |
| A resolver service reading an external policy engine | Correct at a larger scale, and premature here: there is no customer policy engine to read, and an adapter with no far end is a guess about one. |

## Revisit triggers

- **A study carries urgency** → add it as another nullable key column and extend the specificity
  order. The report shape does not change, because the resolved number is still snapshotted.
- **A department needs a per-report exception** → a new ADR. An exception needs its own row and
  its own reason; a field that overrides the rule is the thing this ADR replaced.
- **E9 lands and the IdP supplies role groups** → replace the `clinical_lead` literal with the
  group mapping. The trigger's shape stays; only the predicate changes.
- **More than one organisation shares a deployment** (ADR-0002 says they do not today) → the
  resolution query is already tenant-scoped by RLS, but `template_id` matching across tenants
  would need re-examination, which is why the insert trigger refuses a foreign template now.
