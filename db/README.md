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

`pnpm test` runs the isolation test against `TEST_DATABASE_URL`. It skips itself when the variable
is absent, rather than mocking a database — a policy tested against a mock proves the mock.

## Rules this schema encodes

| Rule | Where | Why |
|---|---|---|
| `org_id` on every clinical row | every table | tenancy is a column, not a deployment (ADR-0003) |
| RLS enabled **and forced** | every table | the owner is subject to it too; there is no privileged path through the app's credentials |
| `app.org_id` must be set | `app_current_org()` | it raises rather than returning zero rows; an empty result looks like an empty database and costs a day to debug |
| Template versions are immutable | trigger + no UPDATE grant | a report points at the snapshot it was authored against |
| Revisions, signatures, audit events are append-only | trigger + no UPDATE/DELETE grant | they are the evidence, not the record of it |
| Reports cannot be deleted | `revoke delete` | a signed report is a legal document |

## Migrations

Hand-authored SQL, applied in filename order, checksummed in `schema_migration`.

Two consequences worth knowing:

- **A migration is applied at most once.** If a file changes after it was applied, the runner
  refuses to start. Write a new migration that supersedes it — the same append-only argument as the
  ADR register.
- **Each file owns its transaction** (`begin` … `commit`), so a failure leaves no half-schema and no
  row in `schema_migration`.

Drizzle is the ratified ORM (ADR-0006) and will generate migrations from a typed schema once the
API exists. Until then there is exactly one source of schema truth: these files. Two sources of
truth would be worse than none.
