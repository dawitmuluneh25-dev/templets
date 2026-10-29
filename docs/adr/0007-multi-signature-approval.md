# ADR-0007 — N-of-M approval with cross-cover

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** project owner (clinical governance decision delegated to the product owner)
- **Relates to:** plan §7 (worklist and co-sign), §8.2 (state machine); D3 in the P0 pack; ADR-0003, ADR-0005

## Context

D3 asked whether a report that needs more than one radiologist is completed by **a single
co-signature** or by **N-of-M with cross-cover**. It was carried as a clinical-governance question
rather than an engineering one, and it was flagged before step 8 because it decides the shape of the
state machine.

It is not only a workflow question. Reading the 0001 schema closely shows the answer had already been
assumed:

```sql
unique (report_id, revision_id, role)
```

Two `approver` signatures on the same revision collide under that constraint. The schema encoded
single co-sign, silently, at the moment the table was created. Every test passed because nothing had
ever tried to add a second approver.

Three properties make the choice expensive to defer:

1. **It is a constraint, not a setting.** Changing it later means migrating rows that were never
   meant to coexist.
2. **It decides what `signed` means.** Under single co-sign, `signed` means "the author plus one
   person". Under N-of-M it means "enough distinct people", and a report can be legitimately
   *waiting* in a state that today has no name.
3. **It is audited.** The event vocabulary (`report.signed`) is evidence. Adding a partial-approval
   event later would leave earlier trails unreadable in the new vocabulary.

## Decision

**A report carries the number of signatures that complete it, and any mixture of distinct people may
supply them, including a delegate signing on behalf of someone absent.**

Concretely:

- `report.approvals_required` (1–5). **1 is solo sign**: the author signs and the report is done.
  **N** means the author plus N−1 others.
- Signature roles: `author` (the reporter), `approver` (a second attending), `delegate`
  (cross-cover, requiring `on_behalf_of`). All three count toward N.
- **Independence is enforced in the database**: only the author may sign as `author`, and nobody may
  countersign their own report. A delegate cannot cover for themselves.
- **One signature per person per revision** — uniqueness moves from `(report_id, revision_id, role)`
  to `(report_id, revision_id, actor_id)`.
- The author's signature on an N>1 report moves it `draft → submitted`; the signature that reaches N
  moves it `submitted → signed`. A partial approval is audible: `report.submitted` and
  `report.countersigned` events with `{signatures, approvals_required}`.
- `signed` is refused at commit unless enough distinct signatures exist **and** at least one is not
  the author (`0004` extends the deferred trigger from `0003`).

## Why N-of-M rather than single co-sign

- **Solo sign is the N=1 case.** Choosing N-of-M loses nothing: a group that wants one signature sets
  1 and gets exactly the simpler model. Choosing single co-sign and later needing two attendings is a
  schema migration plus a rewrite of the completion rule.
- **Cross-cover is the difference between a workflow and a bottleneck.** A report that cannot be
  signed because its designated approver is on leave is a patient waiting. The `delegate` role exists
  so that cover is recorded rather than worked around by sharing a password — which is what happens
  when the software has no legitimate way to express it.
- **It is what the audit trail already wanted to say.** `signature.on_behalf_of` was in the 0001
  schema. Leaving it unused while shipping single co-sign would have meant carrying a column that
  documented an intention the product did not honour.

## Consequences

**Accepted:**

- **The UI has more states to show.** `submitted` is now a real, visible state — 1 of 3 signed — and
  the worklist needs an "awaiting approval" filter and an escalation view. That is work the single
  co-sign model would not have needed.
- **Completion is a count, not a flag.** Every code path that asks "is this done" must ask the
  database, not a boolean it remembered.
- **Delegation has no expiry.** `on_behalf_of` records who was covered for, but nothing limits how
  long that cover lasts or who granted it. A delegation table with dates is the honest next step, and
  this ADR does not pretend to have it.
- **The constraint change is a one-way door.** Migrating back to `(report_id, revision_id, role)`
  would fail on any report that already has two approvers — which is the point.

**Made harder:**

- Approval *sequences* (radiology → attending → department head) are not expressible. N-of-M is
  parallel; a staged chain needs a different model, and that is recorded as a revisit trigger rather
  than quietly approximated.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Single co-sign | The status quo, encoded in a unique constraint. Cheapest today, a migration plus a rule rewrite the first time a group wants two attendings. |
| N-of-M without cross-cover | Reports stall when the designated approver is absent; the workaround in the real world is credential sharing, which destroys the audit trail. |
| Self-approval allowed when the author is the only attending | Turns the second signature into a formality and makes "two signatures" mean nothing. A small group that genuinely has one radiologist uses `approvals_required = 1`. |
| Staged approval chain | Not rejected in principle — rejected *here*, because it needs per-report stage state and an escalation owner, and no customer has asked for it. |

## Revisit triggers

- **A customer requires sequential approval** (author → attending → department head) → new ADR: N-of-M
  is parallel by construction, and stage state belongs in its own table.
- **Delegation needs to expire or be granted** → a `delegation` table with `from`, `to`, `scope`,
  `expires_at`; `on_behalf_of` then references it instead of a bare user id.
- **`approvals_required` needs to vary by study urgency** → it becomes a resolver (template + service +
  urgency) rather than a column, which is a change to the create path only.
