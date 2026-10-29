# db/

Schema, migrations and the tenancy test. PostgreSQL 16.

## First run

```powershell
# 1. Roles and databases (once, as a superuser)
psql -U postgres -v owner_password="$OWNER" -v app_password="$APP" -f db/setup/bootstrap.sql

# 2. Connection strings
Copy-Item .env.example .env.local   # then paste the two passwords in

# 3. Apply migrations
pnpm db:migrate
```

`pnpm test` runs the isolation test and the API's vertical-slice test against `TEST_DATABASE_URL`.
Both skip themselves when the variables are absent, rather than mocking a database — a policy tested
against a mock proves the mock. Each suite creates its own tenants per run, so they can run in
parallel and neither depends on the other's leftovers.

## Rules this schema encodes

| Rule | Where | Why |
|---|---|---|
| `org_id` on every clinical row | every table, `template_version` since 0002 | tenancy is a column, not a deployment (ADR-0003) |
| RLS enabled **and forced** | every table | the owner is subject to it too; there is no privileged path through the app's credentials |
| `app.org_id` must be set | `app_current_org()` | it raises rather than returning zero rows; an empty result looks like an empty database and costs a day to debug |
| Template versions are immutable | trigger + no UPDATE grant | a report points at the snapshot it was authored against |
| Revisions, signatures, audit events are append-only | trigger + no UPDATE/DELETE grant | they are the evidence, not the record of it |
| Reports cannot be deleted | `revoke delete` | a signed report is a legal document |
| Only ratified state transitions commit | `report_state_transition` (0003) | `draft → submitted → signed`, `returned → draft`, `signed → amended`. Anything else is a bug that would otherwise be a row |
| A signature attests a revision | `signature_attests_revision` (0003) | a signature over a hash nobody signed is the signature defect; a wrong hash, a wrong revision and a wrong report are one comparison |
| A signed report has a signature **and** an audit event | `report_signed_requires_evidence` (0003, deferred) | checked at commit, so any order of writes is fine and no code path can skip the evidence |
| `current_hash` is the latest revision | `report_hash_tracks_revision` (0003, deferred) | it is both the `If-Match` token and the value the next signature attests |
| The audit trail is a chain | `audit_event_chain` (0003) | `prev_hash` must be the newest event's hash, so removing or reordering an event breaks the rest |

The deferred triggers are the interesting ones: the sign path writes signature, report and audit
event in one transaction and the order does not matter, but a **committed** transaction that leaves a
report `signed` without both is refused. That is checked by the database rather than by the service,
so a new code path — a data fix, a future endpoint, a migration — cannot bypass it.

## Migrations

Hand-authored SQL, applied in filename order, checksummed in `schema_migration`, guarded by an
advisory lock.

| File | What it does |
|---|---|
| `0001_tenancy_and_evidence.sql` | every table, RLS, the append-only triggers |
| `0002_template_version_tenancy.sql` | `template_version.org_id` + its policy — it holds clinical wording and was reachable by id without a join |
| `0003_evidence_invariants.sql` | the state machine, signature↔revision, signed⇒evidence, hash↔revision, the audit chain |

Three consequences worth knowing:

- **A migration is applied at most once.** If a file changes after it was applied, the runner
  refuses to start. Write a new migration that supersedes it — the same append-only argument as the
  ADR register.
- **Each file owns its transaction** (`begin` … `commit`), so a failure leaves no half-schema and no
  row in `schema_migration`.
- **The runner takes an advisory lock.** Two API replicas booting at once, or a deploy overlapping a
  test run, would otherwise both apply the same file and one would die on a duplicate key — which
  looks like a broken migration rather than a scheduling accident.

Drizzle is the ratified ORM (ADR-0006) and will generate migrations from a typed schema once the
API exists. Until then there is exactly one source of schema truth: these files. Two sources of
truth would be worse than none.
