-- 0009 — How many signatures complete a report is a policy, not a judgement (ADR-0010).
--
-- 0004 made the count a column on the report and let the create body choose it. The only
-- thing between an author and a lower bar was a role check in the service: someone holding
-- `clinical_lead` could ask for 1 where the service wants 3, and every database constraint
-- would still hold, because the constraint knows the number is between 1 and 5 and nothing
-- else. A role check answers "may this person decide" and leaves "what was decided"
-- nowhere. Two radiologists writing the same exam can then require different numbers of
-- signatures and neither is wrong, because nothing was ever written down.
--
-- What changes:
--   1. `approval_policy` — a tenant-scoped rule: this template, or this modality, or the
--      organisation default, requires N signatures. Append-only. The newest row for a key
--      is the live one, so changing a rule is a new row and the previous decision stays in
--      the table where an auditor can find it.
--   2. `report.approval_policy_id` — every report cites the policy its number came from.
--      Enforced at insert, so no future code path can invent a requirement.
--   3. Resolution order — the narrowest matching rule wins. A template names one exam form;
--      a modality names a family. The specific rule is the deliberate exception to the
--      general one, so it has to win.
--
-- Deliberately *not* modelled:
--   - Urgency. ADR-0007 anticipated template + service + urgency. A study in this schema
--     carries no urgency, and inventing a vocabulary (STAT / urgent / routine) in order to
--     have something to match on would be deciding a clinical taxonomy inside a migration.
--     The trigger for adding the axis is the first study that carries one.
--   - A service axis distinct from modality. A template is a service's output, so a rule
--     keyed on template already says "this service requires two". A second axis that
--     usually agrees with the first is two ways to express one decision.
--   - Retiring a rule. Append-only means a key can be given a new number, never removed.
--     Setting a key to 1 is how "no second signature" is recorded, and recording it is the
--     point: an absent rule and a rule that says one are different states.

begin;

create table approval_policy (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references org (id) on delete restrict,
  -- Null is "any". Both null is the organisation default.
  template_id        uuid references template (id) on delete restrict,
  modality           text check (modality is null or length(modality) between 1 and 16),
  approvals_required smallint not null check (approvals_required between 1 and 5),
  -- Why this number. A rule with no reason attached is the thing that gets changed by
  -- whoever is on call.
  rationale          text not null check (length(rationale) between 1 and 500),
  created_by_user_id uuid not null references app_user (id) on delete restrict,
  -- `clock_timestamp`, not `now()`: within one transaction `now()` is fixed, so two rules
  -- written in the same transaction would be indistinguishable and "newest wins" would
  -- fall back to a random UUID. Resolution has to be a total order.
  created_at         timestamptz not null default clock_timestamp()
);

comment on table approval_policy is
  'Tenant-scoped rule for how many signatures complete a report (ADR-0010). Append-only; the newest row for a key is live.';
comment on column approval_policy.template_id is
  'The exam form this rule is about; null means any template. Beats a modality rule.';
comment on column approval_policy.modality is
  'The modality family this rule is about; null means any modality. Beaten by a template rule.';
comment on column approval_policy.approvals_required is
  'Signatures needed. 1 = the author alone; N = the author plus N-1 others (ADR-0007).';

-- The lookup every create performs: the rules that could match, narrowest first.
create index approval_policy_match_idx on approval_policy (org_id, template_id, modality);

alter table approval_policy enable row level security;
alter table approval_policy force  row level security;
create policy approval_policy_org_isolation on approval_policy
  using (org_id = app_current_org()) with check (org_id = app_current_org());

-- Append-only from the application's point of view: it may write a rule and read it.
-- Correcting a rule is a new row, which is what makes the table usable as evidence of
-- what the rule was in March.
grant select, insert on approval_policy to reporting_app;

-- --------------------------------------------------------------------------
-- Who may set the bar.
--
-- `clinical_lead` is a placeholder for E9's IdP role groups (ADR-0007), and it is still
-- the honest answer: the alternative is a number chosen by the person it constrains.
-- What changed is where the check sits. It used to guard a field on a create request;
-- it now guards the rule that the field was standing in for. Checked at insert, not on
-- read: a rule is a decision taken at an instant, and re-checking later would
-- retroactively invalidate rules written by someone who has since changed job.
-- --------------------------------------------------------------------------
create function assert_approval_policy_is_authorised() returns trigger
  language plpgsql
as $$
declare
  by_org    uuid;
  by_roles  text[];
  tmpl_org  uuid;
begin
  select org_id, roles into by_org, by_roles from app_user where id = new.created_by_user_id;

  if by_org is null then
    raise exception 'approval policy names a user that does not exist'
      using errcode = 'check_violation';
  end if;

  if by_org <> new.org_id then
    raise exception 'approval policy names a user from another organisation'
      using errcode = 'check_violation';
  end if;

  if not ('clinical_lead' = any (by_roles)) then
    raise exception 'only a clinical_lead may set how many signatures a report requires'
      using errcode = 'check_violation';
  end if;

  if new.template_id is not null then
    select org_id into tmpl_org from template where id = new.template_id;

    -- A rule keyed on another tenant's template would be a rule that never matches, or
    -- worse, one that matches after a template id is reused. Refused rather than ignored.
    if tmpl_org is null or tmpl_org <> new.org_id then
      raise exception 'approval policy names a template from another organisation'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger approval_policy_is_authorised
  before insert on approval_policy
  for each row execute function assert_approval_policy_is_authorised();

-- --------------------------------------------------------------------------
-- Every report cites the policy its number came from.
--
-- The column is nullable because reports written before this migration have no policy to
-- cite and a backfill would invent one: an organisation default synthesised from the
-- numbers already in the table would retroactively apply to every future report, which is
-- a policy nobody decided. The trigger is what makes it required from here on, which is
-- the same deferred-invariant shape 0003 and 0004 use for evidence.
-- --------------------------------------------------------------------------
alter table report
  add column approval_policy_id uuid references approval_policy (id) on delete restrict;

comment on column report.approval_policy_id is
  'The rule this report''s approvals_required came from. Set at creation and never re-derived.';

create function assert_report_cites_an_approval_policy() returns trigger
  language plpgsql
as $$
begin
  if new.approval_policy_id is null then
    raise exception
      'report cannot be created without an approval policy: the requirement is a rule, not a request field'
      using errcode = 'check_violation';
  end if;

  -- The stored number and the cited rule have to agree. Without this the column would be a
  -- decoration: a report could cite the rule that says 1 while carrying 3, and the trigger
  -- in 0004 would enforce the 3 as though a policy had asked for it.
  if not exists (
    select 1
      from approval_policy p
     where p.id                 = new.approval_policy_id
       and p.org_id             = new.org_id
       and p.approvals_required = new.approvals_required
  ) then
    raise exception
      'report states % signature(s) but cites an approval policy that does not say so',
      new.approvals_required
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger report_cites_an_approval_policy
  before insert on report
  for each row execute function assert_report_cites_an_approval_policy();

commit;
