import { type Pool } from 'pg';

import { type DelegationResource } from '@reporting/contracts';
import { appendAudit, withTenant, type Tx } from '@reporting/db';

import { type Actor } from '../auth.js';
import { problems } from '../errors.js';
import { holdsApprovalAuthority } from '../roles.js';

/**
 * Cross-cover: one person's authority to sign, lent to a colleague for a window.
 *
 * ADR-0007 gave the `delegate` role a job — a report must not stall because its approver
 * is on leave — and left the grant itself unmodelled. `on_behalf_of` recorded the claim;
 * this records the entitlement, so the trail can answer "who said you could sign for
 * them" rather than "you said so".
 *
 * Two rules, both enforced again by the database, because both are the kind that a later
 * refactor drops without noticing:
 *
 * 1. **A grant has an end.** Cover that never expires is cover nobody has to justify
 *    renewing. Ninety days is the cap; a longer absence is two grants.
 * 2. **Only the person lending, or a clinical lead, may lend.** Cover granted by a
 *    bystander is credential sharing with extra steps.
 */

/** How long one grant may last. Reissue rather than open a standing authority. */
const MAX_DELEGATION_DAYS = 90;

export interface DelegationServiceDeps {
  readonly pool: Pool;
}

export interface CreateDelegationInput {
  readonly actor: Actor;
  /** Defaults to the actor: lending your own authority needs no permission. */
  readonly fromUserId?: string;
  readonly toUserId: string;
  /** ISO 8601. Required, because a grant without an end is the thing this exists to stop. */
  readonly expiresAt: string;
}

export interface LiveDelegation {
  readonly id: string;
}

/**
 * The grant a delegate signature would be written under, if one is in force right now.
 *
 * Called inside the signing transaction so the answer cannot go stale between the check
 * and the insert; the signature's own trigger re-checks the same window against
 * `signed_at` rather than against today.
 */
export async function findLiveDelegation(
  tx: Tx,
  input: { readonly fromUserId: string; readonly toUserId: string },
): Promise<LiveDelegation | null> {
  const rows = await tx.query<{ id: string }>(
    `select id
       from delegation
      where from_user_id = $1
        and to_user_id = $2
        and scope = 'approval'
        and now() >= starts_at
        and now() <  expires_at
      order by expires_at desc
      limit 1`,
    [input.fromUserId, input.toUserId],
  );

  return rows.rows[0] ?? null;
}

export async function createDelegation(
  deps: DelegationServiceDeps,
  input: CreateDelegationInput,
): Promise<DelegationResource> {
  const fromUserId = input.fromUserId ?? input.actor.userId;

  if (fromUserId === input.toUserId) {
    throw problems.invalidRequest('Nobody needs cover from themselves.');
  }

  const expiresAt = new Date(input.expiresAt);

  if (Number.isNaN(expiresAt.getTime())) {
    throw problems.invalidRequest('expires_at must be an ISO 8601 timestamp.');
  }

  const now = Date.now();

  if (expiresAt.getTime() <= now) {
    throw problems.invalidRequest(
      'expires_at is in the past, so the grant would be dead on arrival.',
    );
  }

  if (expiresAt.getTime() > now + MAX_DELEGATION_DAYS * 86_400_000) {
    throw problems.invalidRequest(
      `Cover is capped at ${MAX_DELEGATION_DAYS} days. Reissue it rather than granting an open-ended one.`,
    );
  }

  if (fromUserId !== input.actor.userId && !holdsApprovalAuthority(input.actor)) {
    throw problems.forbidden(
      "You may lend your own authority to sign, or grant cover as a clinical lead. Not someone else's.",
    );
  }

  return withTenant(
    deps.pool,
    { orgId: input.actor.orgId, actorId: input.actor.userId },
    async (tx) => {
      // Both parties must be real people in this organisation. Checked here for the error
      // message, and by the trigger's org comparison for the guarantee.
      const users = await tx.query<{ id: string }>(
        'select id from app_user where id = any ($1::uuid[]) and active',
        [[fromUserId, input.toUserId]],
      );

      if (users.rows.length !== 2) {
        throw problems.invalidRequest(
          'from_user_id and to_user_id must name two different active users in this organisation.',
        );
      }

      const inserted = await tx.query<{
        id: string;
        from_user_id: string;
        to_user_id: string;
        granted_by_user_id: string;
        scope: 'approval';
        starts_at: Date;
        expires_at: Date;
      }>(
        `insert into delegation
           (org_id, from_user_id, to_user_id, granted_by_user_id, scope, expires_at)
         values ($1, $2, $3, $4, 'approval', $5)
         returning id, from_user_id, to_user_id, granted_by_user_id, scope, starts_at, expires_at`,
        [
          input.actor.orgId,
          fromUserId,
          input.toUserId,
          input.actor.userId,
          expiresAt.toISOString(),
        ],
      );

      const row = inserted.rows[0];

      if (row === undefined) {
        throw problems.internal('The delegation was not written.');
      }

      // The grant is an act, and acts the audit trail does not record are the ones that
      // get disputed. Same transaction as the row, for the same reason as signing.
      await appendAudit(tx, {
        orgId: input.actor.orgId,
        actorId: input.actor.userId,
        action: 'delegation.granted',
        subjectType: 'delegation',
        subjectId: row.id,
        meta: {
          from_user_id: row.from_user_id,
          to_user_id: row.to_user_id,
          granted_by_user_id: row.granted_by_user_id,
          scope: row.scope,
          expires_at: row.expires_at.toISOString(),
        },
      });

      return {
        id: row.id,
        from_user_id: row.from_user_id,
        to_user_id: row.to_user_id,
        granted_by_user_id: row.granted_by_user_id,
        scope: row.scope,
        starts_at: row.starts_at.toISOString(),
        expires_at: row.expires_at.toISOString(),
      };
    },
  );
}
