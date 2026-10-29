-- 0002 — template_version carries its tenant.
--
-- 0001 put `org_id` on every clinical row except this one, on the argument that it
-- is always reached through `template`. That argument is wrong for RLS: a policy is
-- per table, so a version row could be read by id with no join at all — and a
-- version body is the clinical wording a signed report is pinned to. A table that
-- holds clinical text and is not row-scoped is a hole, not an optimisation.
--
-- The backfill has to write to an append-only table, so the immutability trigger is
-- disabled for the duration. This is safe here and only here: the migration is one
-- transaction (see `begin`/`commit`), `alter table` takes an ACCESS EXCLUSIVE lock,
-- and no other session can observe the table in between. Any *other* update to this
-- table still fails, which is what the isolation test checks.

begin;

alter table template_version add column org_id uuid references org (id) on delete restrict;

alter table template_version disable trigger template_version_immutable;

-- `template` is FORCE-RLS'd, so the owner is subject to its policy and the join
-- would need `app.org_id` — which cannot be set to every tenant at once. Dropping
-- FORCE for the length of this statement lets the owner read all rows; the policy
-- itself stays in place and is re-forced immediately after.
alter table template no force row level security;

update template_version tv
   set org_id = t.org_id
  from template t
 where t.id = tv.template_id;

alter table template force row level security;
alter table template_version enable trigger template_version_immutable;

alter table template_version alter column org_id set not null;

create index template_version_org_idx on template_version (org_id, template_id);

alter table template_version enable row level security;
alter table template_version force  row level security;

create policy template_version_org_isolation on template_version
  using (org_id = app_current_org()) with check (org_id = app_current_org());

-- A version's tenant must equal its template's tenant. A row-level policy cannot
-- express that: it compares the row to the session, not to the parent row. Without
-- this, a version could be inserted into org A pointing at org B's template and each
-- tenant would see half of the pair.
create function assert_version_matches_template_org() returns trigger
  language plpgsql
as $$
begin
  if not exists (
    select 1 from template t
     where t.id = new.template_id
       and t.org_id = new.org_id
  ) then
    raise exception 'template_version.org_id must match its template''s organisation'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger template_version_org_matches
  before insert on template_version
  for each row execute function assert_version_matches_template_org();

commit;
