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

`POST /v1/reports` takes `approvals_required` (1–5, default 1). `POST …/sign` takes `on_behalf_of`,
which is only meaningful for someone who is not the author and makes the signature a `delegate`
covering for that user. A report needing N signatures is signed by N distinct people: the author's
own signature moves it `draft → submitted`, and the signature that reaches N moves it `submitted →
signed`. `report_not_submitted` (409) is what an approver gets if they try to sign before the author.

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
| A signature says only what it may | resolves `author`/`approver`/`delegate` from who is signing | `signature_role_is_honest` — only the author signs as `author`, nobody countersigns their own report, a delegate names whom it covers |
| No lost update on autosave | `If-Match` compared to `current_hash` | `report_hash_tracks_revision` (deferred) |
| The trail cannot be edited | appends only | append-only trigger + no UPDATE grant + chain check |
| Only ratified state changes | checks state before writing | `report_state_transition` |

The duplication is intentional. The service gives a caller a useful error; the database is what is
still true after somebody refactors the service. The contract test writes the forbidden row directly
— the shape a future code path would take — and asserts the commit is refused.

## What is absent, and why

- **Approval policy.** `approvals_required` is taken from the caller on create (1–5). Nothing derives
  it from the service, the template or the study's urgency — ADR-0007's own revisit trigger — and
  nothing stops an author who needs three signatures from asking for one. Until that resolver exists
  the number is a client decision, and it is the one thing in this slice that is a governance
  affordance rather than an enforcement.
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
