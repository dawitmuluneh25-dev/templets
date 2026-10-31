-- 0005 — Cross-cover needs a grant with dates (ADR-0007 revisit trigger).
--
-- 0004 required a delegate signature to name whom it covered (`signature.on_behalf_of`),
-- which recorded the claim but not the authority. Nothing said the cover had ever been
-- granted, or that it was still in force on the day the report was signed. The result is
-- that a signature dated two months after an absence ended is indistinguishable from one
-- dated inside it, and the audit trail cannot answer the only question an auditor asks:
-- "who said you could sign for them?"
--
-- That is the difference between delegation and an assertion, and it is the risk the ADR
-- named against itself: without a grant, the real-world workaround is a shared password,
-- which is exactly what the `delegate` role exists to prevent.
--
-- What changes:
--   1. `delegation` — from, to, who granted it, what it covers, and when it lapses.
--   2. `signature.delegation_id` — the grant a delegate signature was written under.
--   3. `signature_role_is_honest` — a delegate signature must cite a grant that was live
--      at `signed_at`, issued to this signer, by the person the signature names.
--
-- Deliberately *not* modelled: revoking a grant before it expires. Rows are append-only
-- and the window is the only revocation, because an editable grant is a grant whose
-- history nobody can rely on. Early revocation is a new row and an `ended_at`, when a
-- customer asks for it.

begin;

create table delegation (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references org (id) on delete restrict,
  -- The person whose authority is lent (the one who is away).
  from_user_id       uuid not null references app_user (id) on delete restrict,
  -- The person who may exercise it.
  to_user_id         uuid not null references app_user (id) on delete restrict,
  -- Who decided this was allowed. Usually `from_user_id`; a clinical lead may grant it
  -- for someone who is already unreachable, which is the case the table exists for.
  granted_by_user_id uuid not null references app_user (id) on delete restrict,
  scope              text not null default 'approval' check (scope in ('approval')),
  starts_at          timestamptz not null default now(),
  expires_at         timestamptz not null,
  created_at         timestamptz not null default now(),
  constraint delegation_is_not_self check (from_user_id <> to_user_id),
  constraint delegation_expires_after_it_starts check (expires_at > starts_at)
);

comment on table delegation is
  'One person''s authority to sign, lent to a colleague for a bounded window (ADR-0007).';
comment on column delegation.scope is
  'What is lent. Only approval today; per-service cover adds values here, not columns.';
comment on column delegation.granted_by_user_id is
  'The delegator, or a clinical lead granting cover for someone already absent.';

-- The lookup signing performs: "is this person covering for that one, right now".
create index delegation_live_idx on delegation (org_id, to_user_id, expires_at);
create index delegation_from_idx on delegation (org_id, from_user_id, expires_at);

alter table delegation enable row level security;
alter table delegation force  row level security;
create policy delegation_org_isolation on delegation
  using (org_id = app_current_org()) with check (org_id = app_current_org());

-- Append-only from the application's point of view: it may create a grant and read it.
grant select, insert on delegation to reporting_app;

-- --------------------------------------------------------------------------
-- Who may lend authority.
--
-- Enforced at insert, not on read: a grant is a decision taken at an instant, and the
-- role that justified it only has to hold at that instant. Re-checking later would make
-- a legitimate grant retroactively invalid when someone changes job.
-- --------------------------------------------------------------------------
create function assert_delegation_is_authorised() returns trigger
  language plpgsql
as $$
declare
  from_org  uuid;
  to_org    uuid;
  by_org    uuid;
  by_roles  text[];
begin
  select org_id into from_org from app_user where id = new.from_user_id;
  select org_id into to_org   from app_user where id = new.to_user_id;
  select org_id, roles into by_org, by_roles from app_user where id = new.granted_by_user_id;

  if from_org is null or to_org is null or by_org is null then
    raise exception 'delegation names a user that does not exist'
      using errcode = 'check_violation';
  end if;

  if from_org <> new.org_id or to_org <> new.org_id or by_org <> new.org_id then
    raise exception 'delegation crosses an organisation boundary'
      using errcode = 'check_violation';
  end if;

  if new.granted_by_user_id <> new.from_user_id
     and not ('clinical_lead' = any (by_roles)) then
    raise exception
      'only % themselves or a clinical_lead may lend their authority', new.from_user_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger delegation_is_authorised
  before insert on delegation
  for each row execute function assert_delegation_is_authorised();

-- --------------------------------------------------------------------------
-- The signature cites the grant it was written under.
--
-- `on_behalf_of` stays: it is what the signature says. `delegation_id` is what entitled
-- it. Evidence reads better with both, and a grant that lapses later must not change
-- what a signature claims — so the reference is `on delete restrict`, and nothing in
-- the application may delete a cited grant.
-- --------------------------------------------------------------------------
alter table signature
  add column delegation_id uuid references delegation (id) on delete restrict;

comment on column signature.delegation_id is
  'The grant a delegate signature was written under; null for author and approver.';

create or replace function assert_signature_role_is_honest() returns trigger
  language plpgsql
as $$
declare
  report_author uuid;
begin
  select author_id into report_author from report where id = new.report_id;

  if report_author is null then
    raise exception 'signature names report % which does not exist', new.report_id
      using errcode = 'check_violation';
  end if;

  if new.role = 'author' and new.actor_id <> report_author then
    raise exception 'only the author may sign with role author' using errcode = 'check_violation';
  end if;

  if new.role in ('approver', 'delegate') and new.actor_id = report_author then
    raise exception 'the author cannot countersign their own report'
      using errcode = 'check_violation';
  end if;

  if new.role = 'delegate' and new.on_behalf_of is null then
    raise exception 'a delegate signature must name the person it covers for'
      using errcode = 'check_violation';
  end if;

  if new.role <> 'delegate' and new.on_behalf_of is not null then
    raise exception 'only a delegate signature may carry on_behalf_of'
      using errcode = 'check_violation';
  end if;

  if new.on_behalf_of = new.actor_id then
    raise exception 'a delegate signature cannot cover for itself'
      using errcode = 'check_violation';
  end if;

  if new.role = 'delegate' then
    if new.delegation_id is null then
      raise exception 'a delegate signature must cite the delegation it was written under'
        using errcode = 'check_violation';
    end if;

    -- All four conditions in one place: the grant is this signer's, it is for the person
    -- the signature names, it covers approval, and the signature moment falls inside it.
    -- A signature is checked against the clock at signing, never against today.
    if not exists (
      select 1
        from delegation d
       where d.id           = new.delegation_id
         and d.org_id       = new.org_id
         and d.to_user_id   = new.actor_id
         and d.from_user_id = new.on_behalf_of
         and d.scope        = 'approval'
         and new.signed_at >= d.starts_at
         and new.signed_at <  d.expires_at
    ) then
      raise exception
        'signature cites a delegation that was not live from % to % at %',
        new.on_behalf_of, new.actor_id, new.signed_at
        using errcode = 'check_violation';
    end if;
  elsif new.delegation_id is not null then
    raise exception 'only a delegate signature may cite a delegation'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

commit;
