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
| `POST` | `/v1/delegations` | — | `delegation`, `delegation.granted` |

`POST /v1/reports` takes `approvals_required` (1–5, default 1). **Anything above 1 requires the
`clinical_lead` role** — otherwise `403 forbidden`. The requirement is a governance decision, and
setting it is the only place in this slice where that decision is made. `POST …/sign` takes
`on_behalf_of`, which is only meaningful for someone who is not the author and makes the signature a
`delegate` covering for that user — **and only if a grant from that user to the signer is in force**,
otherwise `409 no_active_delegation`. `POST /v1/delegations` creates that grant: you may lend your own
authority to one person until a date, or a `clinical_lead` may lend someone else's. Grants are capped
at 90 days, and a delegate signature cites the grant it was written under, so "who said you could sign
for them" is a row rather than a claim in a request body. A report needing N signatures is signed by N distinct people: the
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
| Cross-cover is authority, not a claim | resolves a live grant before writing, else `409 no_active_delegation` | `signature_role_is_honest` — the cited grant must be this signer's, for the person named, and span `signed_at` |
| Only the person lending, or a clinical lead, may lend | refuses anyone else before writing | `delegation_is_authorised` |
| A grant ends | caps it at 90 days, refuses a past `expires_at` | `delegation_expires_after_it_starts`; the window is the only way it stops being valid |
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
- **Revoking a grant early.** A delegation is append-only and its window is the only way it stops
  being valid; there is no `ended_at` and no delete. Correcting a mistaken grant means waiting it out
  or issuing one that is narrower, which is acceptable while grants are days long and not acceptable
  once they are not. Early revocation is a new column and a second row, when a customer asks.
- **Discovering cover.** A delegate can sign for someone and cannot list whom they cover for. The
  server resolves the grant at signing, so correctness does not depend on the client knowing — but an
  approver UI will want to show it.
- **Sequential approval.** N-of-M is parallel by construction. Author → attending → department head
  needs per-report stage state and an escalation owner, and is deliberately not approximated.
- **Identity (E9) and step-up.** `Authenticator` and `StepUpVerifier` are interfaces with a
  fail-closed default. The only implementations that accept anything are named `HeaderAuthenticator`
  and `TestOnlyFixedTokenStepUp`, and `main.ts` cannot wire the second. A stub password check would
  have made this slice look finished and every signature in it worthless.
- **Clinical validation before signing.** `@reporting/validation` defines the tiers; the rules need a
  filled report to be written against, which is the editor's job (step 9). Signing currently requires
  a revision, not a good one.
- **Template *authoring*.** Templates arrive by import (below). Creating or editing one in the product
  is the library's job and is not built.
- **Vendor-certified integration.** The adapters exist and their mapping is tested; none has been run
  against a vendor sandbox, because there is not one yet (E5). What is proven is that a second vendor
  is a new file behind the same two interfaces, not a change to the domain.
- **Automatic delivery retry.** A failed delivery is recorded and can be retried by asking again; there
  is no scheduler, so nothing retries on its own.
- **Export, dictation, PDF.** Step 10 and later.

## Template import

`template` and `template_version` are populated from the committed corpus artefact, not seeded by hand.

```bash
pnpm --filter @reporting/api import-templates -- --org <uuid> --dry-run   # what would happen
pnpm --filter @reporting/api import-templates -- --org <uuid>            # do it
```

427 templates and 427 versions, or a refusal. The rules:

- **The artefact is validated, not trusted.** zod for shape, then each entry must reproduce its own
  body from its own token stream and match the `char_count` the export recorded. The body that gets
  stored is the reconstructed one, so a stored template cannot render differently from the tokens a
  report was authored against.
- **Identity is `external_id`, not the name.** 427 files share 327 labels (0006). Two templates may
  legitimately both be called "CT Abdomen".
- **Re-running is a no-op.** Version identity is the content hash; the same artefact twice adds
  nothing, and changed text adds version 2 rather than rewriting version 1.
- **Rejections are reported, not fatal.** One bad entry does not withhold the other 426, and the exit
  code is `2` so CI cannot read a partial import as a clean one. `0` imported everything, `1` wrote
  nothing.
- **Licensing is not checked** — the templates are the customer's property (ADR-0009). Provenance is
  recorded on the row and in `corpus/provenance.json`.

## Integration

`src/integration/` is the seam to the systems either side. Two ports — `ContextSource` (patient and
study context) and `ReportSink` (where a signed report goes) — with FHIR R4 implementations of both,
and a registry that builds them from configuration. Nothing in `src/domain/` imports from
`src/integration/adapters/`, and no vendor type appears in a contract.

Two behaviours worth knowing:

- **Unconfigured is not silent.** With no endpoint set, the adapter throws
  `IntegrationNotConfiguredError` naming the capability. The API starts without a hospital behind it
  and refuses to pretend a delivery happened.
- **Delivery is a state machine with a derived key.** `delivery` (0007) holds one attempt series per
  report and target; the key is `sha256(report id, content hash, target)`, so a retry after a timeout
  cannot produce a second report downstream, while two reports that read identically stay distinct.

Configure with `INTEGRATION_EHR_BASE_URL`, `INTEGRATION_EHR_ADAPTER` (default `fhir-r4`),
`INTEGRATION_EHR_TOKEN`, and the same three with an `INTEGRATION_PACS_` or
`INTEGRATION_REPORT_SINK_` prefix. Nothing is configured out of the box.

## Tests

`src/domain/report-service.test.ts` runs the slice against a real PostgreSQL through the runtime role,
and `src/openapi.test.ts` holds the contract. Both are part of `pnpm test`; the database suite skips
itself when `TEST_APP_DATABASE_URL` is unset.
