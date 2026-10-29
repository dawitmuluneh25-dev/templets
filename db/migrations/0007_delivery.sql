-- 0007 — Delivery to an external system is a state machine with an idempotency key.
--
-- The signed report is not the product; the signed report *arriving* is. That step crosses
-- a boundary we do not control, so it must be resumable, retry-safe and auditable, and it
-- must not be re-implemented per vendor (ADR-0010).
--
-- Three properties, each of which is why this is a table and not a field on `report`:
--
-- 1. **A delivery can be retried without duplicating the report downstream.**
--    `idempotency_key` is derived from the report's content hash and target, and is
--    unique per organisation, so a retry after a timeout updates the row rather than
--    creating a second deliverable.
-- 2. **The attempt history is evidence.** `attempts` and `last_error` are what an
--    integration engineer reads at 2 a.m.; a single `delivered` boolean throws that away.
-- 3. **The adapter that did it is recorded.** `adapter` names the implementation, so a
--    vendor swap is visible in the trail rather than inferred from a deployment date.

begin;

create table delivery (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references org (id) on delete restrict,
  report_id       uuid not null references report (id) on delete restrict,
  -- Which downstream system. PACS will carry imaging-linked deliveries; EHR the report.
  target          text not null check (target in ('ehr', 'pacs')),
  -- The adapter implementation that performed (or will perform) it.
  adapter         text not null,
  -- Derived: report content hash + target. A retry must not create a second deliverable.
  idempotency_key text not null,
  status          text not null default 'pending'
                  check (status in ('pending', 'delivered', 'failed')),
  attempts        integer not null default 0 check (attempts >= 0),
  -- What the far end called it, when it says. Useful for support and for reconciliation.
  external_id     text,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  delivered_at    timestamptz,
  unique (org_id, idempotency_key)
);

comment on table delivery is
  'One attempt series per (report, target). Retries update the row; they do not add one.';
comment on column delivery.idempotency_key is
  'sha256 of the report content hash and target, so redelivery of the same bytes is a retry.';

create index delivery_pending_idx on delivery (org_id, status, created_at)
  where status <> 'delivered';

alter table delivery enable row level security;
alter table delivery force  row level security;
create policy delivery_org_isolation on delivery
  using (org_id = app_current_org()) with check (org_id = app_current_org());

grant select, insert, update on delivery to reporting_app;

-- A delivered row is evidence: it must not be deleted, and the report it points at
-- must not either (the FK is restrict). Status may move; the identity may not.
create function assert_delivery_identity_is_stable() returns trigger
  language plpgsql
as $$
begin
  if new.id <> old.id
     or new.org_id <> old.org_id
     or new.report_id <> old.report_id
     or new.target <> old.target
     or new.idempotency_key <> old.idempotency_key then
    raise exception 'a delivery row may change status, not identity'
      using errcode = 'check_violation';
  end if;

  new.updated_at := now();

  return new;
end;
$$;

create trigger delivery_identity_is_stable
  before update on delivery
  for each row execute function assert_delivery_identity_is_stable();

commit;
