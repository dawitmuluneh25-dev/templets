-- 0006 — A template's identity is its source id, not its name.
--
-- 0001 keyed templates on `unique (org_id, name, scope)`, which was a guess made before
-- the corpus existed. It is the same shape of mistake as the `unique (report_id,
-- revision_id, role)` that 0004 had to remove: a plausible key, encoding a decision
-- nobody had taken.
--
-- The corpus disproves it. 427 files, 327 distinct `(name, scope)` pairs: up to eight
-- files share one label, because different protocols legitimately render the same title
-- ("CT Abdomen [variant: CT Abdomen]" appears eight times in one scope). Satisfying the
-- constraint would mean renaming templates — altering the text a radiologist reads — to
-- fit a key. So the key moves to what the source actually uses, and the name goes back to
-- being a label.
--
-- Also here: `licence_status` gains `user_provided`, which is the honest value for the
-- corpus (ADR-0009). It records the basis on which a template is held; it does not gate
-- import, signing or rollout.

begin;

alter table template
  add column external_id   text,
  add column base_name     text not null default '',
  add column variant_label text;

-- The backfill runs with RLS lifted for exactly one statement, because the policy calls
-- `app_current_org()`, which raises when no tenant is set — and a migration has no tenant.
-- The alternative (looping over orgs) cannot start: `org` is itself row-scoped, so the
-- first `select id from org` fails for the same reason. FORCE is restored immediately
-- after, inside the same transaction, so there is no window where the table is unprotected.
alter table template no force row level security;
update template set base_name = name where base_name = '';
alter table template force  row level security;

comment on column template.external_id is
  'Stable identity from the source export (corpus guid). Null for templates authored here.';
comment on column template.base_name is
  'The template this is a variant of. Variants share a base and differ by label.';
comment on column template.variant_label is
  'Site-specific variant of the base template, or null for the base itself.';

alter table template drop constraint template_org_id_name_scope_key;

-- Partial: templates authored in-app have no source id and are not constrained by one.
create unique index template_external_id_key
  on template (org_id, external_id)
  where external_id is not null;

alter table template drop constraint template_licence_status_check;
alter table template add constraint template_licence_status_check
  check (licence_status in ('cleared', 'restricted', 'denied', 'user_provided'));

comment on column template.licence_status is
  'The basis on which this template is held. Recorded for the audit trail, never enforced as a gate (ADR-0009).';

commit;
