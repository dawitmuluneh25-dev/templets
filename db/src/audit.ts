import { canonicalJson, hash } from '@reporting/tokens';

import type { Tx } from './tenant.js';

/**
 * The audit trail, and the chain that makes it one.
 *
 * Each event hashes its own content *plus the hash of the previous event for the
 * same organisation*. That turns a table of rows into a sequence: removing,
 * reordering or editing an event breaks every hash after it. The table is also
 * append-only at the privilege and trigger level, so this is a second, independent
 * barrier rather than the only one — one control that is easy to review, one that
 * is easy to check after the fact.
 *
 * The chain is per organisation and is serialised with an advisory lock. Two
 * concurrent signings in the same tenant would otherwise both read the same
 * `prev_hash` and produce a fork that is indistinguishable from tampering.
 */
export const AUDIT_SCHEMA_VERSION = 1 as const;

const AUDIT_HASH_PREFIX = 'audit-event/v1\n';

export interface AuditEventInput {
  readonly orgId: string;
  readonly actorId: string | null;
  readonly actorRole?: string | null;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly beforeHash?: string | null;
  readonly afterHash?: string | null;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface AppendedAudit {
  readonly id: string;
  readonly hash: string;
  readonly prevHash: string | null;
}

interface HashedPayload {
  readonly v: number;
  readonly org_id: string;
  readonly at: string;
  readonly actor_id: string | null;
  readonly actor_role: string | null;
  readonly action: string;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly before_hash: string | null;
  readonly after_hash: string | null;
  readonly prev_hash: string | null;
  readonly meta: Readonly<Record<string, unknown>>;
}

function eventHash(payload: HashedPayload): string {
  return hash(AUDIT_HASH_PREFIX + canonicalJson(payload));
}

/**
 * Appends one event and returns its hash. Must be called inside the transaction
 * that performed the action — an audit row written afterwards, in its own
 * transaction, records an intention rather than a fact.
 */
export async function appendAudit(tx: Tx, input: AuditEventInput): Promise<AppendedAudit> {
  // hashtextextended gives a stable 64-bit key per organisation; xact-scoped, so
  // it is released with the transaction rather than leaked on a pooled session.
  await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [input.orgId]);

  const head = await tx.query<{ hash: string }>(
    'select hash from audit_event where org_id = $1 order by id desc limit 1',
    [input.orgId],
  );

  const payload: HashedPayload = {
    v: AUDIT_SCHEMA_VERSION,
    org_id: input.orgId,
    at: new Date().toISOString(),
    actor_id: input.actorId,
    actor_role: input.actorRole ?? null,
    action: input.action,
    subject_type: input.subjectType,
    subject_id: input.subjectId,
    before_hash: input.beforeHash ?? null,
    after_hash: input.afterHash ?? null,
    prev_hash: head.rows[0]?.hash ?? null,
    meta: input.meta ?? {},
  };

  const digest = eventHash(payload);

  const inserted = await tx.query<{ id: string }>(
    `insert into audit_event
       (org_id, at, actor_id, actor_role, action, subject_type, subject_id,
        before_hash, after_hash, prev_hash, hash, meta)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning id`,
    [
      payload.org_id,
      payload.at,
      payload.actor_id,
      payload.actor_role,
      payload.action,
      payload.subject_type,
      payload.subject_id,
      payload.before_hash,
      payload.after_hash,
      payload.prev_hash,
      digest,
      JSON.stringify(payload.meta),
    ],
  );

  return { id: inserted.rows[0]?.id ?? '', hash: digest, prevHash: payload.prev_hash };
}

export interface AuditTrailEntry extends HashedPayload {
  readonly id: string;
  readonly hash: string;
}

/** The organisation's trail in insertion order. */
export async function readAuditTrail(tx: Tx, orgId: string): Promise<readonly AuditTrailEntry[]> {
  const rows = await tx.query<{
    id: string;
    at: Date;
    actor_id: string | null;
    actor_role: string | null;
    action: string;
    subject_type: string;
    subject_id: string;
    before_hash: string | null;
    after_hash: string | null;
    prev_hash: string | null;
    hash: string;
    meta: Record<string, unknown>;
  }>(
    `select id, at, actor_id, actor_role, action, subject_type, subject_id,
            before_hash, after_hash, prev_hash, hash, meta
       from audit_event
      where org_id = $1
      order by id`,
    [orgId],
  );

  return rows.rows.map((row) => ({
    id: row.id,
    v: AUDIT_SCHEMA_VERSION,
    org_id: orgId,
    at: row.at.toISOString(),
    actor_id: row.actor_id,
    actor_role: row.actor_role,
    action: row.action,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    before_hash: row.before_hash,
    after_hash: row.after_hash,
    prev_hash: row.prev_hash,
    hash: row.hash,
    meta: row.meta,
  }));
}

export interface ChainCheck {
  readonly ok: boolean;
  /** Index of the first entry that does not verify; `null` when the chain holds. */
  readonly firstBrokenIndex: number | null;
  readonly length: number;
}

/**
 * Recomputes the chain from the stored rows.
 *
 * This is the check an auditor runs years later, so it must depend on nothing
 * but the table: it rebuilds each payload from the columns as stored and
 * compares the digest. It therefore also proves that the canonicalisation is
 * stable across a `jsonb` round-trip, which is the assumption the whole scheme
 * rests on.
 */
export function verifyChain(entries: readonly AuditTrailEntry[]): ChainCheck {
  let previous: string | null = null;

  for (const [index, entry] of entries.entries()) {
    const payload: HashedPayload = {
      v: entry.v,
      org_id: entry.org_id,
      at: entry.at,
      actor_id: entry.actor_id,
      actor_role: entry.actor_role,
      action: entry.action,
      subject_type: entry.subject_type,
      subject_id: entry.subject_id,
      before_hash: entry.before_hash,
      after_hash: entry.after_hash,
      prev_hash: entry.prev_hash,
      meta: entry.meta,
    };

    if (entry.prev_hash !== previous || eventHash(payload) !== entry.hash) {
      return { ok: false, firstBrokenIndex: index, length: entries.length };
    }

    previous = entry.hash;
  }

  return { ok: true, firstBrokenIndex: null, length: entries.length };
}

export async function checkAuditChain(tx: Tx, orgId: string): Promise<ChainCheck> {
  return verifyChain(await readAuditTrail(tx, orgId));
}
