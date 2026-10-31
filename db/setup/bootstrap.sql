-- Creates the two roles and two databases the workspace needs.
--
-- Run once, as a superuser:
--
--   psql -U postgres -v owner_password="$OWNER" -v app_password="$APP" \
--        -f db/setup/bootstrap.sql
--
-- Why two roles: ADR-0003 requires that the application role owns nothing and
-- has no BYPASSRLS, so row-level security applies to it with no exceptions. The
-- owner runs migrations; the app serves requests.
--
-- CI passes throwaway passwords for a container that is destroyed with the job.

\set ON_ERROR_STOP on

select format('create role reporting_owner login password %L', :'owner_password')
where not exists (select 1 from pg_roles where rolname = 'reporting_owner')
\gexec

select format('create role reporting_app login password %L', :'app_password')
where not exists (select 1 from pg_roles where rolname = 'reporting_app')
\gexec

-- No BYPASSRLS, ever. Stated explicitly so a future edit has to delete a line
-- that says why.
alter role reporting_app nobypassrls;

select 'create database reporting_dev owner reporting_owner'
where not exists (select 1 from pg_database where datname = 'reporting_dev')
\gexec

select 'create database reporting_test owner reporting_owner'
where not exists (select 1 from pg_database where datname = 'reporting_test')
\gexec
