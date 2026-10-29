-- 0002 — the invariants that make a signature mean something.
--
-- 0001 created the tables. Tables do not hold a claim together: a `report` row
-- with `state = 'signed'`, no signature and no audit event is a perfectly valid
-- row, and it is exactly the row an auditor would find after a bug in the sign
-- path. The invariants below are enforced in the database because the service
-- layer is the thing that can be wrong.
--
-- Every check is a constraint, not a comment. Each one answers a question an
-- auditor will ask, and each one is written so the answer does not depend on the
-- code that happened to run.

begin;

-- --------------------------------------------------------------------------
-- The state machine.
--
-- Ratified edges only. Deliberately valid under *both* answers to D3:
--   draft -> submitted  (author sends for approval)
--   draft -> signed     (attending-only / solo sign)
--   submitted -> signed (approval countersigns)
--   submitted -> returned, returned -> draft (sent back for edits)
--   signed -> amended   (an addendum never edits a signed revision)
--
-- N-of-M with cross-cover changes the *guard* on `submitted -> signed` — how many
-- approvals, from whom — not the edge set. That is why this trigger is a table of
-- edges and not a chain of bespoke ifs: the D3 answer is a new guard, not a
-- rewrite, and this comment is the claim being staked.
-- --------------------------------------------------------------------------
create function report_state_transition() returns trigger
  language plpgsql
as $$
begin
  if new.state = old.state then
    return new;
  end if;

  if not (
       (old.state = 'draft'     and new.state in ('submitted', 'signed'))
    or (old.state = 'submitted' and new.state in ('signed', 'returned'))
    or (old.state = 'returned'  and new.state = 'draft')
    or (old.state = 'signed'    and new.state = 'amended')
  ) then
    raise exception 'report state % -> % is not a permitted transition', old.state, new.state
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger report_state_transition
  before update on report
  for each row execute function report_state_transition();

-- --------------------------------------------------------------------------
-- A signature attests the revision it names.
--
-- The classic signature defect is not a missing signature, it is a signature
-- over bytes nobody signed: a stale hash copied from the previous revision, a
-- hash of the template rather than the filled report, a revision belonging to a
-- different report. All three are one comparison, so they are checked here.
-- --------------------------------------------------------------------------
create function assert_signature_attests_revision() returns trigger
  language plpgsql
as $$
begin
  if not exists (
    select 1
      from report r
      join report_revision rv on rv.id = new.revision_id
     where r.id = new.report_id
       and rv.report_id = new.report_id
       and r.org_id = new.org_id
       and rv.org_id = new.org_id
       and rv.content_hash = new.content_hash
  ) then
    raise exception
      'signature must attest the content hash of the revision it names (report %)', new.report_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger signature_attests_revision
  before insert on signature
  for each row execute function assert_signature_attests_revision();

-- --------------------------------------------------------------------------
-- A signed report has its evidence.
--
-- Deferred to commit: the sign path writes signature, report and audit event in
-- one transaction, and any order is fine — but a committed transaction that
-- leaves `state = 'signed'` without both is refused. This is the assertion the
-- contract test aims at, and it is checked by the database rather than by the
-- service, so a new code path cannot skip it.
-- --------------------------------------------------------------------------
create function assert_signed_report_has_evidence() returns trigger
  language plpgsql
as $$
begin
  if not exists (
    select 1 from signature s
     where s.report_id = new.id
       and s.content_hash = new.current_hash
  ) then
    raise exception 'report % is signed but has no signature over its current hash', new.id
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

create constraint trigger report_signed_requires_evidence
  after insert or update on report
  deferrable initially deferred
  for each row
  when (new.state = 'signed')
  execute function assert_signed_report_has_evidence();

-- --------------------------------------------------------------------------
-- `current_hash` is the latest revision, or nothing.
--
-- It is both the optimistic-concurrency token and the value the next signature
-- will attest, so a stale one is a lost update that looks like a successful
-- save. A report with no revisions yet is exempt: creation writes both rows in
-- the same transaction, and a deferred trigger sees the committed state.
-- --------------------------------------------------------------------------
create function assert_report_hash_is_latest_revision() returns trigger
  language plpgsql
as $$
declare
  latest text;
begin
  select rv.content_hash into latest
    from report_revision rv
   where rv.report_id = new.id
   order by rv.revision desc
   limit 1;

  if latest is not null and latest <> new.current_hash then
    raise exception 'report % current_hash does not match its latest revision', new.id
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

create constraint trigger report_hash_tracks_revision
  after insert or update on report
  deferrable initially deferred
  for each row
  execute function assert_report_hash_is_latest_revision();

-- --------------------------------------------------------------------------
-- The audit chain.
--
-- `prev_hash` must equal the newest event's hash. Enforced on insert so a chain
-- cannot fork, and so a bug in the append helper fails here instead of producing
-- a trail that only looks intact.
-- --------------------------------------------------------------------------
create function assert_audit_chain() returns trigger
  language plpgsql
as $$
declare
  newest text;
begin
  select hash into newest
    from audit_event
   where org_id = new.org_id
   order by id desc
   limit 1;

  if new.prev_hash is null then
    if newest is not null then
      raise exception 'audit event must extend the chain: prev_hash is null but the chain is not empty'
        using errcode = 'check_violation';
    end if;
  elsif newest is distinct from new.prev_hash then
    raise exception 'audit chain broken: prev_hash does not match the newest event for this organisation'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger audit_event_chain
  before insert on audit_event
  for each row execute function assert_audit_chain();

commit;
