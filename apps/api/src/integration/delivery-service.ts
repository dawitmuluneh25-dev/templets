import { createHash } from 'node:crypto';

import { type Pool } from 'pg';

import { withTenant } from '@reporting/db';
import { render } from '@reporting/tokens';

import { problems } from '../errors.js';
import { type FinalReport, type ReportSink } from './ports.js';

/**
 * Delivering a signed report, resumably.
 *
 * The shape of this file is dictated by one fact: the far end is not ours. A POST can time
 * out after the other system has accepted it, so "did it arrive" is not answerable from a
 * response code alone. Three consequences, all visible below:
 *
 * - **The key is derived, not generated.** It comes from the report's content hash and the
 *   target, so re-running delivery is a retry of the same thing rather than a second thing.
 *   A random id would make every retry a duplicate report in the EHR.
 * - **No network call happens inside a transaction.** Holding a row lock while waiting on
 *   another hospital's server is how a queue becomes an outage.
 * - **Failure is a recorded state, not an exception to the caller.** `attempts` and
 *   `last_error` are the operational record; the caller gets a typed outcome.
 *
 * What this does not do: retry on its own. There is no scheduler yet, so a failed delivery
 * stays failed until something asks again — the state is durable so that asking is safe.
 */

export type DeliveryTarget = 'ehr' | 'pacs';

export interface DeliveryServiceDeps {
  readonly pool: Pool;
  readonly reportSink: ReportSink;
}

export interface DeliverReportInput {
  readonly orgId: string;
  readonly reportId: string;
  readonly target?: DeliveryTarget;
}

export type DeliveryOutcome =
  | {
      readonly status: 'delivered';
      readonly deliveryId: string;
      readonly externalId: string | null;
      /** True when this call found the report already delivered and did nothing. */
      readonly duplicate: boolean;
    }
  | {
      readonly status: 'failed';
      readonly deliveryId: string;
      readonly attempts: number;
      readonly error: string;
    };

/**
 * Derived from the bytes and the destination. Two calls for the same signed report to the
 * same system collapse onto one row by construction, which is the only way a retry after a
 * timeout is safe.
 */
export function deliveryIdempotencyKey(
  reportId: string,
  contentHash: string,
  target: DeliveryTarget,
): string {
  // The report id is not decoration. Hashing content and target alone made two different
  // reports that happened to read the same — same template, same findings, very common —
  // collapse onto one delivery row, so the second was never delivered and reported itself
  // as a duplicate. Identity has to be part of the key.
  return `sha256:${createHash('sha256')
    .update(`${reportId}:${contentHash}:${target}`)
    .digest('hex')}`;
}

interface ReportRow {
  readonly state: string;
  readonly current_hash: string;
  readonly signed_at: string | null;
  readonly study_instance_uid: string;
  readonly author_identifier: string;
  readonly author_name: string;
  /** The token document. Named sections in 0001, which is a worse name for it. */
  readonly sections: { tokens: readonly unknown[] };
  readonly field_values: Readonly<Record<string, string>>;
}

export async function deliverReport(
  deps: DeliveryServiceDeps,
  input: DeliverReportInput,
): Promise<DeliveryOutcome> {
  const target: DeliveryTarget = input.target ?? 'ehr';

  // Phase 1 — read and claim, in a short transaction.
  const claimed = await withTenant(deps.pool, { orgId: input.orgId }, async (tx) => {
    const found = await tx.query<ReportRow>(
      `select r.state, r.current_hash, r.signed_at, s.study_instance_uid,
              u.idp_subject as author_identifier, u.display_name as author_name,
              rv.sections, rv.field_values
         from report r
         join study s on s.id = r.study_id
         join app_user u on u.id = r.author_id
         join report_revision rv
           on rv.report_id = r.id
          and rv.revision = (select max(revision) from report_revision where report_id = r.id)
        where r.id = $1`,
      [input.reportId],
    );

    const report = found.rows[0];

    if (report === undefined) throw problems.reportNotFound(input.reportId);

    if (report.state !== 'signed' || report.signed_at === null) {
      throw problems.reportNotSigned(
        'Only a signed report is delivered. A draft has nothing to attest and a submitted report is still waiting on signatures.',
      );
    }

    const key = deliveryIdempotencyKey(input.reportId, report.current_hash, target);

    const existing = await tx.query<{
      id: string;
      status: string;
      attempts: number;
      external_id: string | null;
    }>(
      'select id, status, attempts, external_id from delivery where org_id = $1 and idempotency_key = $2',
      [input.orgId, key],
    );

    const row = existing.rows[0];

    if (row !== undefined && row.status === 'delivered') {
      return {
        alreadyDelivered: {
          deliveryId: row.id,
          externalId: row.external_id,
        } as const,
      };
    }

    const deliveryId =
      row === undefined
        ? (
            await tx.query<{ id: string }>(
              `insert into delivery
                 (org_id, report_id, target, adapter, idempotency_key, status, attempts)
               values ($1, $2, $3, $4, $5, 'pending', 1)
               returning id`,
              [input.orgId, input.reportId, target, deps.reportSink.id, key],
            )
          ).rows[0]?.id
        : (
            await tx.query<{ id: string }>(
              `update delivery
                  set status = 'pending', attempts = attempts + 1
                where id = $1
                returning id`,
              [row.id],
            )
          ).rows[0]?.id;

    if (deliveryId === undefined) throw new Error('Delivery row was not written.');

    const attempts =
      row === undefined
        ? 1
        : ((
            await tx.query<{ attempts: number }>('select attempts from delivery where id = $1', [
              deliveryId,
            ])
          ).rows[0]?.attempts ?? 1);

    const payload: FinalReport = {
      reportId: input.reportId,
      contentHash: report.current_hash,
      text: render(report.sections.tokens as never, { fieldValues: report.field_values }),
      signedAt: report.signed_at,
      author: { identifier: report.author_identifier, displayName: report.author_name },
      studyInstanceUid: report.study_instance_uid,
    };

    return { deliveryId, attempts, payload } as const;
  });

  if ('alreadyDelivered' in claimed) {
    return {
      status: 'delivered',
      deliveryId: claimed.alreadyDelivered.deliveryId,
      externalId: claimed.alreadyDelivered.externalId,
      duplicate: true,
    };
  }

  // Phase 2 — the call itself, holding nothing.
  let externalId: string | null = null;
  let failure: string | null = null;

  try {
    const receipt = await deps.reportSink.deliver(claimed.payload);
    externalId = receipt.externalId;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  // Phase 3 — record what happened, in another short transaction.
  await withTenant(deps.pool, { orgId: input.orgId }, async (tx) => {
    if (failure === null) {
      await tx.query(
        `update delivery
            set status = 'delivered', external_id = $2, last_error = null, delivered_at = now()
          where id = $1`,
        [claimed.deliveryId, externalId],
      );

      return;
    }

    await tx.query(`update delivery set status = 'failed', last_error = $2 where id = $1`, [
      claimed.deliveryId,
      failure.slice(0, 2_000),
    ]);
  });

  if (failure !== null) {
    return {
      status: 'failed',
      deliveryId: claimed.deliveryId,
      attempts: claimed.attempts,
      error: failure,
    };
  }

  return {
    status: 'delivered',
    deliveryId: claimed.deliveryId,
    externalId,
    duplicate: false,
  };
}
