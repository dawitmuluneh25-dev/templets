-- 0001 — tenancy, template snapshot, report evidence.
--
-- The first migration, so it carries the two decisions that are expensive to
-- retrofit: `org_id` on every clinical row (ADR-0003), and template versions
-- that are immutable once written (ADR-0005 keeps the token stream canonical;
-- this keeps the snapshot it was authored against).
--
-- Row-level security is FORCEd, not merely enabled: the table owner is subject
-- to it too. That means migrations and tests must set `app.org_id` like the
-- application does, which is the point — there is no privileged path through the
-- API's own credentials.

begin;

-- The tenant for the current transaction. Setting it is the caller's
-- responsibility; not setting it raises rather than returning nothing, because a
-- query that silently returns zero rows looks like an empty database and gets
-- debugged for a day.
create function app_current_org() returns uuid
  language sql
  stable
as $$
  select current_setting('app.org_id')::uuid
$$;

create function reject_mutation() returns trigger
  language plpgsql
as $$
begin
  raise exception 'append-only: % rows cannot be % ', tg_table_name, lower(tg_op)
    using errcode = 'restrict_violation';
end;
$$;

create table org (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  timezone    text not null default 'UTC',
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create table app_user (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references org (id) on delete restrict,
  idp_subject   text not null,
  display_name  text not null,
  roles         text[] not null default '{}',
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (org_id, idp_subject)
);

create table template (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references org (id) on delete restrict,
  name            text not null,
  scope           text not null,
  modality        text not null,
  body_system     text,
  type            text not null,
  -- Provenance is data, not a comment: licence clearing is a flag with an audit
  -- record, and the system must be able to answer "under what right was this
  -- report signed" years later (ADR-0004).
  provenance      jsonb not null,
  licence_status  text not null default 'restricted'
                  check (licence_status in ('cleared', 'restricted', 'denied')),
  status          text not null default 'active'
                  check (status in ('active', 'deprecated')),
  created_at      timestamptz not null default now(),
  unique (org_id, name, scope)
);

create table template_version (
  id             uuid primary key default gen_random_uuid(),
  template_id    uuid not null references template (id) on delete restrict,
  version        integer not null check (version >= 1),
  body           text not null,
  token_stream   jsonb not null,
  fields         jsonb not null default '[]'::jsonb,
  content_hash   text not null,
  created_by     uuid references app_user (id) on delete restrict,
  created_at     timestamptz not null default now(),
  unique (template_id, version),
  unique (template_id, content_hash)
);

create table study (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references org (id) on delete restrict,
  study_instance_uid  text not null,
  accession           text,
  modality            text not null,
  body_part           text,
  performed_at        timestamptz,
  -- Minimal by design: demographics are referenced, not copied (plan §5.1).
  patient_ref         jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  unique (org_id, study_instance_uid)
);

create table report (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references org (id) on delete restrict,
  study_id             uuid not null references study (id) on delete restrict,
  template_version_id  uuid not null references template_version (id) on delete restrict,
  state                text not null default 'draft'
                       check (state in ('draft', 'submitted', 'signed', 'amended', 'returned')),
  author_id            uuid not null references app_user (id) on delete restrict,
  assigned_signer_id   uuid references app_user (id) on delete restrict,
  current_hash         text not null,
  urgent               boolean not null default false,
  parent_report_id     uuid references report (id) on delete restrict,
  created_at           timestamptz not null default now(),
  signed_at            timestamptz
);

create table report_revision (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references org (id) on delete restrict,
  report_id     uuid not null references report (id) on delete restrict,
  revision      integer not null check (revision >= 1),
  sections      jsonb not null,
  field_values  jsonb not null default '{}'::jsonb,
  content_hash  text not null,
  author_id     uuid not null references app_user (id) on delete restrict,
  reason        text not null
                check (reason in ('draft_save', 'submitted', 'edited_and_approved', 'returned', 'addendum')),
  created_at    timestamptz not null default now(),
  unique (report_id, revision)
);

create table signature (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references org (id) on delete restrict,
  report_id     uuid not null references report (id) on delete restrict,
  revision_id   uuid not null references report_revision (id) on delete restrict,
  actor_id      uuid not null references app_user (id) on delete restrict,
  role          text not null check (role in ('author', 'approver', 'delegate')),
  method        text not null
                check (method in ('password_step_up', 'sso_step_up', 'hardware_key')),
  content_hash  text not null,
  signed_at     timestamptz not null default now(),
  on_behalf_of  uuid references app_user (id) on delete restrict,
  auth_context  jsonb not null default '{}'::jsonb,
  unique (report_id, revision_id, role)
);

create table audit_event (
  id            bigint generated always as identity primary key,
  org_id        uuid not null references org (id) on delete restrict,
  at            timestamptz not null default now(),
  actor_id      uuid references app_user (id) on delete restrict,
  actor_role    text,
  action        text not null,
  subject_type  text not null,
  subject_id    text not null,
  before_hash   text,
  after_hash    text,
  prev_hash     text,
  hash          text not null,
  meta          jsonb not null default '{}'::jsonb
);

-- Indexing: org_id leads every composite, because it is in every predicate once
-- RLS is doing its job.
create index report_org_state_signer_idx on report (org_id, state, assigned_signer_id, created_at);
create index report_study_idx on report (study_id);
create index report_revision_report_idx on report_revision (report_id, revision);
create index signature_report_idx on signature (report_id);
create index audit_event_org_at_idx on audit_event using brin (org_id, at);
create index audit_event_subject_idx on audit_event (subject_id, subject_type);
create index template_org_idx on template (org_id, status);
create index study_org_idx on study (org_id, accession);

-- Append-only tables refuse UPDATE and DELETE outright, whatever privilege a
-- caller holds. Privileges are the first gate; this is the second.
create trigger template_version_immutable
  before update or delete on template_version
  for each row execute function reject_mutation();

create trigger report_revision_immutable
  before update or delete on report_revision
  for each row execute function reject_mutation();

create trigger signature_immutable
  before update or delete on signature
  for each row execute function reject_mutation();

create trigger audit_event_immutable
  before update or delete on audit_event
  for each row execute function reject_mutation();

-- Tenancy: enable and FORCE on every table that carries org_id.
alter table app_user         enable row level security;
alter table app_user         force  row level security;
alter table template         enable row level security;
alter table template         force  row level security;
alter table study            enable row level security;
alter table study            force  row level security;
alter table report           enable row level security;
alter table report           force  row level security;
alter table report_revision  enable row level security;
alter table report_revision  force  row level security;
alter table signature        enable row level security;
alter table signature        force  row level security;
alter table audit_event      enable row level security;
alter table audit_event      force  row level security;

create policy app_user_org_isolation on app_user
  using (org_id = app_current_org()) with check (org_id = app_current_org());
create policy template_org_isolation on template
  using (org_id = app_current_org()) with check (org_id = app_current_org());
create policy study_org_isolation on study
  using (org_id = app_current_org()) with check (org_id = app_current_org());
create policy report_org_isolation on report
  using (org_id = app_current_org()) with check (org_id = app_current_org());
create policy report_revision_org_isolation on report_revision
  using (org_id = app_current_org()) with check (org_id = app_current_org());
create policy signature_org_isolation on signature
  using (org_id = app_current_org()) with check (org_id = app_current_org());
create policy audit_event_org_isolation on audit_event
  using (org_id = app_current_org()) with check (org_id = app_current_org());

-- `org` is not row-scoped: a deployment is one organisation (ADR-0002). The app
-- may read its own row only.
alter table org enable row level security;
alter table org force  row level security;
create policy org_self_only on org
  using (id = app_current_org()) with check (id = app_current_org());

-- The application role gets exactly what it needs. It does not own anything and
-- has no BYPASSRLS, so a missing WHERE clause returns another tenant's rows only
-- if the policy is wrong — which is what the isolation test checks.
grant usage on schema public to reporting_app;

grant select, insert, update, delete on app_user, template, study, report to reporting_app;
grant select, insert on template_version, report_revision, signature, audit_event to reporting_app;
grant select on org to reporting_app;
grant usage, select on all sequences in schema public to reporting_app;

-- Reports may not be hard-deleted: a signed report is evidence.
revoke delete on report from reporting_app;

commit;
