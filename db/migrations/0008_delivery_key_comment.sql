-- 0008 — Correcting a comment, and saying why it was wrong.
--
-- 0007 said the delivery key was derived from the report's content hash and target. It is
-- not: it also carries the report id, because two different reports frequently read
-- identically (same template, same findings) and hashing the text alone collapsed them onto
-- one row — so the second was never delivered and reported itself as a duplicate.
--
-- A comment on an evidence table is read by whoever is debugging a missing report at 2 a.m.
-- Leaving a false one in place because "it is only a comment" is how the next person trusts
-- the wrong thing. Migrations are append-only, so the correction is a new file.

begin;

comment on column delivery.idempotency_key is
  'sha256 over report id, report content hash and target. Retrying the same signed report to the same system is a retry; a different report is not, even when the text is identical.';

commit;
