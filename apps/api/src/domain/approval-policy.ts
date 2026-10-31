import { type Pool } from 'pg';

import { type ApprovalPolicyResource } from '@reporting/contracts';
import { appendAudit, withTenant, type Tx } from '@reporting/db';

import { type Actor } from '../auth.js';
import { problems } from '../errors.js';
import { APPROVAL_AUTHORITY_ROLE, holdsApprovalAuthority } from '../roles.js';

/**
 * How many signatures complete a report is a rule, not a field on a request (ADR-0010).
 *
 * Until this module existed the number travelled from caller to column with only a role
 * check in between. That check answered *may this person decide* and left *what was
 * decided* nowhere: two radiologists writing the same exam could require different numbers
 * of signatures and both be right, because nothing had been written down. A policy table
 * turns the decision into a row that can be read, cited and overturned by a later row.
 *
 * The resolution rule, which is the whole of the design:
 *
 * 1. **The narrowest matching rule wins.** A template names one exam form; a modality
 *    names a family. The specific rule is the deliberate exception to the general one, so
 *    it has to win, or writing an exception would be pointless.
 * 2. **Within one key, the newest row wins.** Changing a rule appends; the previous
 *    decision stays in the table. `created_at` orders by real time, not transaction time.
 * 3. **No matching rule is an error, not a default.** Falling back to 1 would reproduce
 *    the hole this closes, in the one state — a fresh deployment — where nobody would
 *    notice it. A create with no rule behind it is refused.
 *
 * The resolved number is copied onto the report and the policy id with it, so a later
 * policy change never re-bars a report that was already created under the old rule.
 */

/** The column is `smallint check (1..5)`; a value outside it must be a 400, not a 500. */
const MIN_APPROVALS_REQUIRED = 1;
const MAX_APPROVALS_REQUIRED = 5;

/** Long enough to explain a rule, short enough that it is a note and not a document. */
const MAX_RATIONALE_LENGTH = 500;

export interface ApprovalPolicyServiceDeps {
  readonly pool: Pool;
}

export interface CreateApprovalPolicyInput {
  readonly actor: Actor;
  /** Null or absent means "any template"; both that and modality unset is the org default. */
  readonly templateId?: string | undefined;
  /** Null or absent means "any modality". */
  readonly modality?: string | undefined;
  readonly approvalsRequired: number;
  /** Why this number. Required: a rule with no reason is the one that gets changed by whoever is on call. */
  readonly rationale: string;
}

/** The rule a new report will be created under. */
export interface ResolvedApprovalPolicy {
  readonly id: string;
  readonly approvals_required: number;
}

/**
 * The narrowest live rule that covers this template and modality, or a refusal.
 *
 * Called inside the creating transaction so the answer cannot go stale between the read
 * and the insert, and so the report and the rule it cites commit together or not at all.
 */
export async function resolveApprovalPolicy(
  tx: Tx,
  input: { readonly templateId: string; readonly modality: string },
): Promise<ResolvedApprovalPolicy> {
  const rows = await tx.query<ResolvedApprovalPolicy>(
    `select p.id, p.approvals_required
       from approval_policy p
      where (p.template_id is null or p.template_id = $1)
        and (p.modality    is null or p.modality    = $2)
      order by (
                 (case when p.template_id is not null then 2 else 0 end)
               + (case when p.modality    is not null then 1 else 0 end)
               ) desc,
               p.created_at desc,
               p.id desc
      limit 1`,
    [input.templateId, input.modality],
  );

  const policy = rows.rows[0];

  if (policy === undefined) {
    throw problems.noApprovalPolicy(
      `No approval policy covers template ${input.templateId} or modality "${input.modality}". ` +
        `A ${APPROVAL_AUTHORITY_ROLE} has to set one before reports can be created from it.`,
    );
  }

  return policy;
}

export async function createApprovalPolicy(
  deps: ApprovalPolicyServiceDeps,
  input: CreateApprovalPolicyInput,
): Promise<ApprovalPolicyResource> {
  const rationale = input.rationale.trim();

  // Range and text first, authority second: telling someone their number is not a thing is
  // more useful than telling them they may not have it.
  if (
    !Number.isInteger(input.approvalsRequired) ||
    input.approvalsRequired < MIN_APPROVALS_REQUIRED ||
    input.approvalsRequired > MAX_APPROVALS_REQUIRED
  ) {
    throw problems.invalidRequest(
      `approvals_required must be a whole number between ${MIN_APPROVALS_REQUIRED} and ${MAX_APPROVALS_REQUIRED}.`,
    );
  }

  if (rationale.length === 0 || rationale.length > MAX_RATIONALE_LENGTH) {
    throw problems.invalidRequest(
      `rationale is required and may not exceed ${MAX_RATIONALE_LENGTH} characters.`,
    );
  }

  if (!holdsApprovalAuthority(input.actor)) {
    throw problems.forbidden(
      `Only a ${APPROVAL_AUTHORITY_ROLE} may set how many signatures a report requires.`,
    );
  }

  return withTenant(
    deps.pool,
    { orgId: input.actor.orgId, actorId: input.actor.userId },
    async (tx) => {
      if (input.templateId !== undefined) {
        // RLS makes another tenant's template invisible, so this is also the cross-tenant
        // check. The trigger re-checks it — the service is the part that gets refactored.
        const template = await tx.query<{ id: string }>('select id from template where id = $1', [
          input.templateId,
        ]);

        if (template.rows.length === 0) {
          throw problems.invalidRequest(
            'template_id must name a template in this organisation, or be omitted.',
          );
        }
      }

      const inserted = await tx.query<{
        id: string;
        template_id: string | null;
        modality: string | null;
        approvals_required: number;
        rationale: string;
        created_by_user_id: string;
        created_at: Date;
      }>(
        `insert into approval_policy
           (org_id, template_id, modality, approvals_required, rationale, created_by_user_id)
         values ($1, $2, $3, $4, $5, $6)
         returning id, template_id, modality, approvals_required, rationale,
                   created_by_user_id, created_at`,
        [
          input.actor.orgId,
          input.templateId ?? null,
          input.modality ?? null,
          input.approvalsRequired,
          rationale,
          input.actor.userId,
        ],
      );

      const row = inserted.rows[0];

      if (row === undefined) {
        throw problems.internal('The approval policy was not written.');
      }

      // A rule change is exactly the kind of act whose history gets disputed later —
      // "who raised the bar on CT heads, and when" — so it is evidence, not configuration.
      await appendAudit(tx, {
        orgId: input.actor.orgId,
        actorId: input.actor.userId,
        action: 'approval_policy.set',
        subjectType: 'approval_policy',
        subjectId: row.id,
        meta: {
          template_id: row.template_id,
          modality: row.modality,
          approvals_required: row.approvals_required,
        },
      });

      return {
        id: row.id,
        template_id: row.template_id,
        modality: row.modality,
        approvals_required: row.approvals_required,
        rationale: row.rationale,
        created_by_user_id: row.created_by_user_id,
        created_at: row.created_at.toISOString(),
      };
    },
  );
}

/**
 * Every rule in the tenant, narrowest first.
 *
 * Bounded by construction — one row per template and modality combination — so this is a
 * list and not a paginated collection. A governance surface that cannot be read back is
 * one nobody can check their own writes against.
 */
export async function listApprovalPolicies(
  deps: ApprovalPolicyServiceDeps,
  actor: Actor,
): Promise<readonly ApprovalPolicyResource[]> {
  return withTenant(deps.pool, { orgId: actor.orgId, actorId: actor.userId }, async (tx) => {
    const rows = await tx.query<{
      id: string;
      template_id: string | null;
      modality: string | null;
      approvals_required: number;
      rationale: string;
      created_by_user_id: string;
      created_at: Date;
    }>(
      `select id, template_id, modality, approvals_required, rationale,
              created_by_user_id, created_at
         from approval_policy
        order by (
                   (case when template_id is not null then 2 else 0 end)
                 + (case when modality    is not null then 1 else 0 end)
                 ) desc,
                 created_at desc,
                 id desc`,
    );

    return rows.rows.map((row) => ({
      id: row.id,
      template_id: row.template_id,
      modality: row.modality,
      approvals_required: row.approvals_required,
      rationale: row.rationale,
      created_by_user_id: row.created_by_user_id,
      created_at: row.created_at.toISOString(),
    }));
  });
}
