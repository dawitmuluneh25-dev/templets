# ADR-0003 — `org_id` on every clinical row, RLS enforced in the database

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** project owner; tech lead (role unfilled)
- **Relates to:** production plan §6.1, §6.3, §7.3; ADR-0002

## Context

ADR-0002 chose a single-tenant deployment, which makes tenancy look unnecessary. Two reasons
it still is:

1. **The tenancy boundary is the customer organisation, not the hospital.** One organisation
   already spans multiple sites and referring hospitals, and a future pooled profile is the
   documented escape hatch (ADR-0002, revisit triggers). Column-and-policy tenancy makes that
   a configuration change; retrofitting it is a migration across every table, index and query.
2. **The dominant serious defect class in clinical software is a missing predicate.** Not a
   forgotten `if`, a forgotten `WHERE`. Application-level filtering is correct exactly as
   often as every query author is. A row-level policy makes the omission return zero rows
   instead of another organisation's PHI.

This is defence in depth, not the authorisation model. "May this user sign this report" is a
separate question answered in the API (§7.4). RLS answers only "which rows may this
connection see".

## Decision

- Every PHI-bearing table carries `org_id uuid not null references org(id)`, and `org_id` is
  the leading column of every composite index on that table. Cross-organisation rows in one
  table are a bug, not a feature.
- RLS is **enabled and forced** on those tables, with `USING` and `WITH CHECK` both
  `org_id = current_setting('app.org_id')::uuid`.
- The organisation is set from the authenticated session, per transaction:
  `SET LOCAL app.org_id = $1`. Never from a request body, path segment, header or query
  parameter. A missing setting raises; there is no default organisation.
- The application role does not own the tables and has no `BYPASSRLS`. Migrations run as a
  separate DDL role. Production `superuser` is a break-glass credential with an audit trail.
- Workers set `app.org_id` explicitly per job, from the job payload that was itself written
  inside a scoped transaction.
- A schema-driven test enumerates every table with an `org_id` column, seeds two
  organisations, and asserts that SELECT, UPDATE and DELETE across the boundary affect zero
  rows. A new table without a policy fails the test — the test is generated from the schema
  catalogue, not maintained by hand.

## Consequences

**Accepted:**

- Connection pooling must respect the setting. In transaction-mode pooling the `SET LOCAL`
  has to happen inside the same transaction as the query it scopes; that constrains how the
  data layer is used and has to be encoded in the repository layer, not left to callers.
- Every data access runs inside a transaction. That is a small ergonomic cost and a
  measurable performance cost (negligible when `org_id` leads the index).
- Seed scripts, migrations and analytics jobs need an explicit organisation context or an
  explicit bypass role. Both are visible in code review, which is the point.

**Made harder:**

- Debugging "why does this query return nothing" now includes "is the GUC set". The error
  must be explicit (raise on missing setting) rather than silently returning zero rows.
- Ad-hoc psql access by an engineer will return nothing without setting the GUC. That is
  correct behaviour and worth documenting in the runbook rather than working around.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Application-level filtering only | One forgotten predicate is a breach. The cost of RLS is one policy per table. |
| Schema per tenant | Migration fan-out, connection routing, and cross-tenant reference data joins become manual. |
| Database per tenant in the primary profile | Operationally fine, but it forecloses the pooled escape hatch and makes reference data (templates, terminologies) a synchronisation problem. |
| No tenancy at all, single customer forever | Cheapest today, most expensive at the first contract that needs isolation. |

## Revisit triggers

- The pooled profile is adopted → add per-tenant KMS keys on top; RLS stays unchanged.
- Audit volume makes a single partitioned table unmanageable → consider partitioning by
  `org_id, month` rather than month alone.
- A query pattern emerges that cannot tolerate per-transaction scoping → solve it with a
  scoped read replica, not by relaxing the policy.
