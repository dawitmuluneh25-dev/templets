-- 0004 — N-of-M approval with cross-cover (D3, decided 2026-10-29).
--
-- The 0001 schema encoded single co-sign without saying so: `unique (report_id,
-- revision_id, role)` means a second `approver` on the same revision collides with
-- the first. That constraint *is* the decision, and it was the wrong one — a
-- radiology group that wants two attendings to agree could not be expressed.
--
-- What changes:
--   1. `report.approvals_required` — how many signatures complete this report.
--      1 is solo sign (the author alone); N is author + (N-1) others.
--   2. Uniqueness becomes per person per revision, so N distinct people can sign
--      the same bytes.
--   3. Independence: nobody countersigns their own report, and a delegate
--      signature must name whom it covers.
--
-- Cross-cover is the `delegate` role: someone signing on behalf of an absent
-- attending. It counts toward the requirement, which is the point — the alternative
-- is a report stuck unsigned because the approver is on leave.

begin;

alter table report
  add column approvals_required smallint not null default 1
  check (approvals_required between 1 and 5);

comment on column report.approvals_required is
  'Signatures needed to complete this report. 1 = author alone; N = author plus N-1 others.';

-- Per person, not per role: two attendings can both be `approver`.
alter table signature drop constraint signature_report_id_revision_id_role_key;
alter table signature add constraint signature_one_per_person_per_revision
  unique (report_id, revision_id, actor_id);

-- --------------------------------------------------------------------------
-- Independence and cross-cover.
-- --------------------------------------------------------------------------
create function assert_signature_role_is_honest() returns trigger
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

  return new;
end;
$$;

create trigger signature_role_is_honest
  before insert on signature
  for each row execute function assert_signature_role_is_honest();

-- --------------------------------------------------------------------------
-- "Signed" now means: enough distinct people, at least one not the author.
--
-- Replaces the 0003 body: same two evidence checks, plus the count. Still deferred
-- to commit, so signature rows, the report update and the audit event can be
-- written in any order within one transaction.
-- --------------------------------------------------------------------------
create or replace function assert_signed_report_has_evidence() returns trigger
  language plpgsql
as $$
declare
  latest_revision uuid;
  signature_count integer;
  independent_count integer;
begin
  select id into latest_revision
    from report_revision
   where report_id = new.id
   order by revision desc
   limit 1;

  if latest_revision is null then
    raise exception 'report % is signed but has no revision', new.id
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from signature s
     where s.report_id = new.id
       and s.revision_id = latest_revision
       and s.content_hash = new.current_hash
  ) then
    raise exception 'report % is signed but has no signature over its current hash', new.id
      using errcode = 'check_violation';
  end if;

  select count(*), count(*) filter (where s.actor_id <> new.author_id)
    into signature_count, independent_count
    from signature s
   where s.report_id = new.id
     and s.revision_id = latest_revision;

  if signature_count < new.approvals_required then
    raise exception
      'report % is signed with % signature(s) but requires %',
      new.id, signature_count, new.approvals_required
      using errcode = 'check_violation';
  end if;

  if new.approvals_required > 1 and independent_count = 0 then
    raise exception
      'report % requires % signatures, so at least one must come from someone other than the author',
      new.id, new.approvals_required
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from audit_event a
     where a.org_id = new.org_id
       and a.subject_type = 'report'
       and a.subject_id = new.id::text
       and a.action = 'report.signed'
  ) then
    raise exception 'report % is signed but has no report.signed audit event', new.id
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

commit;
