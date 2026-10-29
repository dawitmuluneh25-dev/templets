# apps/api

The headless vertical slice: **create a report from a pinned template version → autosave a revision →
sign it, with the signature and the audit event in one transaction.** Fastify + Zod, OpenAPI 3.1
generated from the same schemas (ADR-0006).

Not a product API yet. It is the shortest path through the system that exercises every decision made
so far — tenancy, the token model, immutability, the audit trail — and nothing beyond it.

## Run it

```powershell
pnpm db:migrate                 # 0001 … 0004
pnpm --filter @reporting/api build
pnpm --filter @reporting/api start
```

`APP_DATABASE_URL` must point at the **runtime** role (`reporting_app`). Starting as the owner would
work and would quietly make every policy irrelevant, so the connection string is named after the role
it should be.

Signing will return `503 step_up_unavailable` on a fresh checkout, and every request will be `401`
unless identity is configured. That is deliberate — see *What is absent* below.

## Endpoints

| Method | Path | `If-Match` | Writes |
|---|---|---|---|
| `POST` | `/v1/reports` | — | `report`, `report_revision` 1, `report.created` |
| `GET` | `/v1/reports/:id` | — | nothing |
| `PUT` | `/v1/reports/:id/draft` | required | next `report_revision`, `report.current_hash`, `report.draft_saved` |
| `POST` | `/v1/reports/:id/sign` | required | `signature`; `report.state='submitted'` with `report.submitted`/`report.countersigned`, or `'signed'` with `report.signed` when the count is reached |

`POST /v1/reports` takes `approvals_required` (1–5, default 1). **Anything above 1 requires the
`clinical_lead` role** — otherwise `403 forbidden`. The requirement is a governance decision, and
setting it is the only place in this slice where that decision is made. `POST …/sign` takes
`on_behalf_of`, which is only meaningful for someone who is not the author and makes the signature a
`delegate` covering for that user. A report needing N signatures is signed by N distinct people: the
author's own signature moves it `draft → submitted`, and the signature that reaches N moves it
`submitted → signed`. `report_not_submitted` (409) is what an approver gets if they try to sign
before the author.

Every report carries `approvals_required`, `approvals_remaining` and the `signatures` collected on its
**current** revision. `approvals_remaining` is derived on each read from those signatures, so a client
never has to reimplement the completion rule. A report waiting for approval is therefore rendered
from the report alone — "2 of 3 signed, 1 more needed" — and the query a worklist needs is:

```sql
-- reports awaiting my signature, in my tenant
select r.id
  from report r
 where r.state = 'submitted'
   and r.author_id <> $me
   and not exists (
     select 1 from signature s
       join report_revision rv on rv.id = s.revision_id
      where s.report_id = r.id
        and s.actor_id = $me
        and rv.revision = (select max(revision) from report_revision where report_id = r.id)
   );
```

That predicate is stated here rather than implemented as an endpoint: a list route needs a
pagination and filter contract nobody has decided, and P1 has not yet said whether the worklist view
is this phase or the next.

Errors are RFC 9457 problem details. Branch on `code`; `title` and `detail` are for humans and may be
reworded. `detail` never echoes a field value — a validation failure names the JSON path and the rule
code, because the value is clinical text.

The document lives in `openapi.json`, is generated (`pnpm --filter @reporting/api openapi`) and is
diffed in CI. It cannot describe an endpoint that does not exist, or miss one that does.

## Where each guarantee is enforced

| Guarantee | Service | Database |
|---|---|---|
| A report only ever sees its own tenant | tenant set per transaction | `FORCE ROW LEVEL SECURITY` + policy |
| A signature attests a real revision | signs `report.current_hash` after comparing it to the latest revision | `signature_attests_revision` |
| A signed report has evidence | writes both rows in one transaction | `report_signed_requires_evidence` (deferred) — since 0004 it also demands the signature *count* reach `approvals_required`, with at least one non-author among them |
| One signature per person per revision | refuses a duplicate signer before writing | `signature_one_per_person_per_revision` |
| An author cannot lower their own bar | refuses `approvals_required > 1` without `clinical_lead` | `check (approvals_required between 1 and 5)` — the range, not the authority |
| A signature says only what it may | resolves `author`/`approver`/`delegate` from who is signing | `signature_role_is_honest` — only the author signs as `author`, nobody countersigns their own report, a delegate names whom it covers |
| No lost update on autosave | `If-Match` compared to `current_hash` | `report_hash_tracks_revision` (deferred) |
| The trail cannot be edited | appends only | append-only trigger + no UPDATE grant + chain check |
| Only ratified state changes | checks state before writing | `report_state_transition` |

The duplication is intentional. The service gives a caller a useful error; the database is what is
still true after somebody refactors the service. The contract test writes the forbidden row directly
— the shape a future code path would take — and asserts the commit is refused.

## What is absent, and why

- **An approval *policy*.** `approvals_required` is still not derived from the service, the template or
  the study's urgency — ADR-0007's revisit trigger. What exists instead is a named authority: only a
  `clinical_lead` may ask for more than one signature, and the value is written into the
  `report.created` event so the trail shows what the report was asked to be. That closes the "author
  asks for 1 and self-completes" hole without inventing a policy model, but the role name itself is a
  placeholder — it is what E9's IdP role groups will populate, and the resolver will remove the need
  for it.
- **Delegation with an expiry.** `on_behalf_of` records who a delegate covered for. It does not record
  who granted the cover or when it lapses, so cross-cover is an assertion by the signer. A
  `delegation` table is the honest next step and ADR-0007 says so.
- **Sequential approval.** N-of-M is parallel by construction. Author → attending → department head
  needs per-report stage state and an escalation owner, and is deliberately not approximated.
- **Identity (E9) and step-up.** `Authenticator` and `StepUpVerifier` are interfaces with a
  fail-closed default. The only implementations that accept anything are named `HeaderAuthenticator`
  and `TestOnlyFixedTokenStepUp`, and `main.ts` cannot wire the second. A stub password check would
  have made this slice look finished and every signature in it worthless.
- **Clinical validation before signing.** `@reporting/validation` defines the tiers; the rules need a
  filled report to be written against, which is the editor's job (step 9). Signing currently requires
  a revision, not a good one.
- **Template import.** `template` and `template_version` are seeded by tests. The corpus importer
  produces the artefacts; wiring them into rows is a separate, reviewable change.
- **Delivery, export, dictation, EHR/PACS.** Step 10.

## Tests

`src/domain/report-service.test.ts` runs the slice against a real PostgreSQL through the runtime role,
and `src/openapi.test.ts` holds the contract. Both are part of `pnpm test`; the database suite skips
itself when `TEST_APP_DATABASE_URL` is unset.
