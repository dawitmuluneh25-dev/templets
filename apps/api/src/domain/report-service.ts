import { type Pool } from 'pg';

import { type ReportResource, type ReportState } from '@reporting/contracts';
import { appendAudit, withTenant, type Tx } from '@reporting/db';
import { contentHash, type FieldDescriptor, type TokenDocument } from '@reporting/tokens';

import { type Actor, type StepUpVerifier } from '../auth.js';
import { problems } from '../errors.js';
import { asTokenDocument } from './document.js';

/**
 * The headless vertical slice: create → autosave → sign, each step one
 * transaction that also writes its audit event.
 *
 * Three properties are being built here, in this order of importance:
 *
 * 1. **A signature is over a hash that exists.** The service reads the revision,
 *    hashes nothing itself, and the database refuses a signature whose hash is
 *    not the revision's (migration 0003). Two independent checks, because the
 *    service is the part that will be refactored.
 * 2. **The audit event is in the same transaction as the act.** Not a queue, not
 *    a hook — if the event and the signature could commit separately, the trail
 *    would record intentions.
 * 3. **Optimistic concurrency on `current_hash`.** Two sessions editing one draft
 *    is normal in a worklist; a lost update is a clinical error, not a UX nit.
 */
export interface ReportServiceDeps {
  readonly pool: Pool;
  readonly stepUp: StepUpVerifier;
}

/** A value the API refuses to store: unbounded field values are a storage bug. */
const MAX_FIELD_VALUE_LENGTH = 20_000;

export interface CreateReportInput {
  readonly actor: Actor;
  readonly templateVersionId: string;
  readonly studyInstanceUid: string;
  readonly accession?: string | undefined;
  readonly modality: string;
  readonly fieldValues?: Readonly<Record<string, string>>;
  /** 1 = solo sign; N = the author plus N-1 others (D3). */
  readonly approvalsRequired?: number | undefined;
}

export interface SaveDraftInput {
  readonly actor: Actor;
  readonly reportId: string;
  /** The `current_hash` the client last saw; compared, never trusted. */
  readonly ifMatch: string;
  readonly fieldValues: Readonly<Record<string, string>>;
}

export interface SignReportInput {
  readonly actor: Actor;
  readonly reportId: string;
  readonly ifMatch: string;
  /** The step-up assertion presented with the sign request, if any. */
  readonly stepUpAssertion: string | undefined;
  /**
   * Cross-cover: the user this signature covers for. Only meaningful when the signer
   * is not the author; the database refuses a delegate signature without it.
   */
  readonly onBehalfOf?: string | undefined;
}

export type SignatureRole = 'author' | 'approver' | 'delegate';

interface ReportRow {
  readonly id: string;
  readonly state: ReportState;
  readonly author_id: string;
  readonly template_version_id: string;
  readonly current_hash: string;
  readonly signed_at: Date | null;
  readonly approvals_required: number;
}

interface VersionRow {
  readonly token_stream: unknown;
  readonly fields: readonly FieldDescriptor[];
}

export async function createReport(
  deps: ReportServiceDeps,
  input: CreateReportInput,
): Promise<ReportResource> {
  const fieldValues = input.fieldValues ?? {};

  return withTenant(
    deps.pool,
    { orgId: input.actor.orgId, actorId: input.actor.userId },
    async (tx) => {
      const version = await loadVersion(tx, input.templateVersionId);
      const document = asTokenDocument(version.token_stream, 'template_version.token_stream');

      assertKnownFields(version.fields, fieldValues);

      const digest = contentHash(document, fieldValues);

      const study = await tx.query<{ id: string }>(
        `insert into study (org_id, study_instance_uid, accession, modality)
       values ($1, $2, $3, $4)
       on conflict (org_id, study_instance_uid) do update
         set accession = coalesce(excluded.accession, study.accession)
       returning id`,
        [input.actor.orgId, input.studyInstanceUid, input.accession ?? null, input.modality],
      );

      const studyId = study.rows[0]?.id;
      if (studyId === undefined) throw problems.internal('study insert returned no row');

      const report = await tx.query<{ id: string }>(
        `insert into report (org_id, study_id, template_version_id, author_id, current_hash,
                            approvals_required)
       values ($1, $2, $3, $4, $5, $6)
       returning id`,
        [
          input.actor.orgId,
          studyId,
          input.templateVersionId,
          input.actor.userId,
          digest,
          input.approvalsRequired ?? 1,
        ],
      );

      const reportId = report.rows[0]?.id;
      if (reportId === undefined) throw problems.internal('report insert returned no row');

      await insertRevision(tx, {
        orgId: input.actor.orgId,
        reportId,
        revision: 1,
        document,
        fieldValues,
        digest,
        authorId: input.actor.userId,
        reason: 'draft_save',
      });

      await appendAudit(tx, {
        orgId: input.actor.orgId,
        actorId: input.actor.userId,
        action: 'report.created',
        subjectType: 'report',
        subjectId: reportId,
        beforeHash: null,
        afterHash: digest,
        meta: { template_version_id: input.templateVersionId, revision: 1 },
      });

      return loadResource(tx, reportId);
    },
  );
}

export async function saveDraft(
  deps: ReportServiceDeps,
  input: SaveDraftInput,
): Promise<ReportResource> {
  return withTenant(
    deps.pool,
    { orgId: input.actor.orgId, actorId: input.actor.userId },
    async (tx) => {
      const report = await lockReport(tx, input.reportId);

      if (report.state !== 'draft' && report.state !== 'returned') {
        throw problems.reportNotEditable(report.state);
      }

      if (report.current_hash !== input.ifMatch) throw problems.preconditionFailed();

      const version = await loadVersion(tx, report.template_version_id);
      const document = asTokenDocument(version.token_stream, 'template_version.token_stream');

      assertKnownFields(version.fields, input.fieldValues);

      const digest = contentHash(document, input.fieldValues);
      const revision = await nextRevision(tx, report.id);

      await insertRevision(tx, {
        orgId: input.actor.orgId,
        reportId: report.id,
        revision,
        document,
        fieldValues: input.fieldValues,
        digest,
        authorId: input.actor.userId,
        reason: 'draft_save',
      });

      await tx.query('update report set current_hash = $2 where id = $1', [report.id, digest]);

      await appendAudit(tx, {
        orgId: input.actor.orgId,
        actorId: input.actor.userId,
        action: 'report.draft_saved',
        subjectType: 'report',
        subjectId: report.id,
        beforeHash: report.current_hash,
        afterHash: digest,
        meta: { revision },
      });

      return loadResource(tx, report.id);
    },
  );
}

/**
 * Signing. The order of checks matters and is deliberate:
 *
 * 1. is the report mine and in a signable state,
 * 2. is my `If-Match` still current,
 * 3. does a revision exist whose hash matches what I am about to sign,
 * 4. can step-up even be verified here,
 * 5. did it verify.
 *
 * Step-up is checked last among the failures because it is the only one that costs
 * a user interaction: telling someone to authenticate before telling them their
 * draft is stale wastes their second factor and teaches them to ignore the prompt.
 */
export async function signReport(
  deps: ReportServiceDeps,
  input: SignReportInput,
): Promise<ReportResource> {
  return withTenant(
    deps.pool,
    { orgId: input.actor.orgId, actorId: input.actor.userId },
    async (tx) => {
      const report = await lockReport(tx, input.reportId);

      if (report.state === 'signed') throw problems.reportAlreadySigned();
      if (report.state !== 'draft' && report.state !== 'submitted') {
        throw problems.reportNotEditable(report.state);
      }

      if (report.current_hash !== input.ifMatch) throw problems.preconditionFailed();

      const isAuthor = input.actor.userId === report.author_id;

      // An approver signs a report the author has already signed. Allowing an
      // approver onto a draft would produce a state the database refuses at commit
      // (signed, with the author's own signature missing) - a 500 instead of a 409.
      if (!isAuthor && report.state === 'draft') throw problems.reportNotSubmitted();

      const latest = await tx.query<{ id: string; revision: number; content_hash: string }>(
        `select id, revision, content_hash
         from report_revision
        where report_id = $1
        order by revision desc
        limit 1`,
        [report.id],
      );

      const revision = latest.rows[0];
      if (revision === undefined) {
        throw problems.revisionMismatch('The report has no revision to sign.');
      }

      if (revision.content_hash !== report.current_hash) {
        throw problems.revisionMismatch(
          'The report hash does not match its latest revision; save before signing.',
        );
      }

      // D3 (decided): N-of-M with cross-cover. The author's signature is one of
      // the N; everyone else's is an approval; a `delegate` signature is an
      // approval given on behalf of an absent attending and counts toward N.
      const alreadySigned = await tx.query(
        'select 1 from signature where report_id = $1 and revision_id = $2 and actor_id = $3',
        [report.id, revision.id, input.actor.userId],
      );

      if (alreadySigned.rowCount !== null && alreadySigned.rowCount > 0) {
        throw problems.alreadySigned('You have already signed this revision.');
      }

      const onBehalfOf = isAuthor ? null : (input.onBehalfOf ?? null);

      if (onBehalfOf !== null) {
        const delegate = await tx.query<{ id: string }>(
          'select id from app_user where id = $1 and active',
          [onBehalfOf],
        );

        if (delegate.rows[0] === undefined) {
          throw problems.invalidRequest('on_behalf_of names no active user in this organisation.');
        }

        if (onBehalfOf === input.actor.userId) {
          throw problems.invalidRequest('A delegate signature cannot cover for itself.');
        }
      }

      if (!deps.stepUp.available) {
        throw problems.stepUpUnavailable(
          'No step-up verifier is configured (entry condition E9). Signing is disabled rather than unchecked.',
        );
      }

      const grant = await deps.stepUp.verify(
        input.actor,
        { purpose: 'report.sign', reportId: report.id, contentHash: report.current_hash },
        input.stepUpAssertion,
      );

      if (grant === null) {
        throw problems.stepUpRequired(
          input.stepUpAssertion === undefined
            ? 'Re-authenticate to sign: no step-up assertion was presented.'
            : 'The step-up assertion was rejected or expired.',
        );
      }

      const role: SignatureRole = isAuthor
        ? 'author'
        : onBehalfOf === null
          ? 'approver'
          : 'delegate';

      await tx.query(
        `insert into signature
           (org_id, report_id, revision_id, actor_id, role, method, content_hash,
            auth_context, on_behalf_of)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          input.actor.orgId,
          report.id,
          revision.id,
          input.actor.userId,
          role,
          grant.method,
          revision.content_hash,
          JSON.stringify(grant.authContext),
          onBehalfOf,
        ],
      );

      // Count what is on the revision now. Two signatures from the same person are
      // impossible (unique per person per revision), so this is a count of people.
      const collected = await tx.query<{ count: number }>(
        'select count(*)::int as count from signature where report_id = $1 and revision_id = $2',
        [report.id, revision.id],
      );

      const signatures = collected.rows[0]?.count ?? 1;
      const complete = signatures >= report.approvals_required;

      if (complete) {
        await tx.query(
          `update report
              set state = 'signed', signed_at = now(), assigned_signer_id = $2
            where id = $1`,
          [report.id, input.actor.userId],
        );

        await appendAudit(tx, {
          orgId: input.actor.orgId,
          actorId: input.actor.userId,
          actorRole: role,
          action: 'report.signed',
          subjectType: 'report',
          subjectId: report.id,
          beforeHash: null,
          afterHash: revision.content_hash,
          meta: {
            revision_id: revision.id,
            revision: revision.revision,
            method: grant.method,
            signatures,
            approvals_required: report.approvals_required,
            on_behalf_of: onBehalfOf,
          },
        });
      } else {
        // Not enough yet. A draft becomes `submitted` (the author has signed and the
        // report is now with approvers); a submitted report simply waits.
        if (report.state === 'draft') {
          await tx.query("update report set state = 'submitted' where id = $1", [report.id]);
        }

        await appendAudit(tx, {
          orgId: input.actor.orgId,
          actorId: input.actor.userId,
          actorRole: role,
          action: isAuthor ? 'report.submitted' : 'report.countersigned',
          subjectType: 'report',
          subjectId: report.id,
          beforeHash: null,
          afterHash: revision.content_hash,
          meta: {
            revision_id: revision.id,
            revision: revision.revision,
            method: grant.method,
            signatures,
            approvals_required: report.approvals_required,
            on_behalf_of: onBehalfOf,
          },
        });
      }
      return loadResource(tx, report.id);
    },
  );
}

export async function getReport(
  deps: ReportServiceDeps,
  actor: Actor,
  reportId: string,
): Promise<ReportResource> {
  return withTenant(deps.pool, { orgId: actor.orgId, actorId: actor.userId }, async (tx) =>
    loadResource(tx, reportId),
  );
}

/* ------------------------------------------------------------------ helpers */

async function lockReport(tx: Tx, reportId: string): Promise<ReportRow> {
  // FOR UPDATE, so two signers cannot both pass the state check and both write a
  // signature for the same revision.
  const row = await tx.query<ReportRow>(
    `select id, state, author_id, template_version_id, current_hash, signed_at,
            approvals_required
       from report
      where id = $1
      for update`,
    [reportId],
  );

  const report = row.rows[0];
  if (report === undefined) throw problems.reportNotFound(reportId);

  return report;
}

async function loadVersion(tx: Tx, templateVersionId: string): Promise<VersionRow> {
  const row = await tx.query<{ token_stream: unknown; fields: readonly FieldDescriptor[] }>(
    'select token_stream, fields from template_version where id = $1',
    [templateVersionId],
  );

  const version = row.rows[0];
  if (version === undefined) throw problems.templateVersionNotFound(templateVersionId);

  return version;
}

async function nextRevision(tx: Tx, reportId: string): Promise<number> {
  const row = await tx.query<{ next: number }>(
    'select coalesce(max(revision), 0) + 1 as next from report_revision where report_id = $1',
    [reportId],
  );

  return row.rows[0]?.next ?? 1;
}

interface InsertRevisionInput {
  readonly orgId: string;
  readonly reportId: string;
  readonly revision: number;
  readonly document: TokenDocument;
  readonly fieldValues: Readonly<Record<string, string>>;
  readonly digest: string;
  readonly authorId: string;
  readonly reason: 'draft_save' | 'submitted' | 'edited_and_approved' | 'returned' | 'addendum';
}

async function insertRevision(tx: Tx, input: InsertRevisionInput): Promise<void> {
  await tx.query(
    `insert into report_revision
       (org_id, report_id, revision, sections, field_values, content_hash, author_id, reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.orgId,
      input.reportId,
      input.revision,
      JSON.stringify(input.document),
      JSON.stringify(input.fieldValues),
      input.digest,
      input.authorId,
      input.reason,
    ],
  );
}

/**
 * Rejects values for keys the pinned template does not have.
 *
 * A stored value that no field renders is invisible in the report and present in
 * the database — which is how a client bug becomes a support investigation. The
 * error names the offending keys and never the values.
 */
function assertKnownFields(
  fields: readonly FieldDescriptor[],
  fieldValues: Readonly<Record<string, string>>,
): void {
  const known = new Set(fields.map((field) => field.key));
  const unknown = Object.keys(fieldValues).filter((key) => !known.has(key));

  if (unknown.length > 0) {
    throw problems.invalidRequest(
      `Unknown field keys for this template version: ${unknown.slice(0, 5).join(', ')}`,
    );
  }

  for (const [key, value] of Object.entries(fieldValues)) {
    if (value.length > MAX_FIELD_VALUE_LENGTH) {
      throw problems.invalidRequest(`Field "${key}" exceeds ${MAX_FIELD_VALUE_LENGTH} characters.`);
    }
  }
}

async function loadResource(tx: Tx, reportId: string): Promise<ReportResource> {
  const row = await tx.query<ReportRow & { token_stream: unknown }>(
    `select r.id, r.state, r.author_id, r.template_version_id, r.current_hash, r.signed_at,
            r.approvals_required, tv.token_stream
       from report r
       join template_version tv on tv.id = r.template_version_id
      where r.id = $1`,
    [reportId],
  );

  const report = row.rows[0];
  if (report === undefined) throw problems.reportNotFound(reportId);

  const latest = await tx.query<{ revision: number; field_values: Record<string, string> }>(
    `select revision, field_values
       from report_revision
      where report_id = $1
      order by revision desc
      limit 1`,
    [reportId],
  );

  const revision = latest.rows[0];

  const signatures = await tx.query<{ actor_id: string; role: SignatureRole; signed_at: Date }>(
    `select actor_id, role, signed_at
       from signature
      where report_id = $1
      order by signed_at`,
    [reportId],
  );

  return {
    id: report.id,
    state: report.state,
    template_version_id: report.template_version_id,
    revision: revision?.revision ?? 0,
    document: asTokenDocument(report.token_stream, 'template_version.token_stream'),
    field_values: revision?.field_values ?? {},
    current_hash: report.current_hash,
    signed_at: report.signed_at === null ? null : report.signed_at.toISOString(),
    approvals_required: report.approvals_required,
    signatures: signatures.rows.map((row) => ({
      actor_id: row.actor_id,
      role: row.role,
      signed_at: row.signed_at.toISOString(),
    })),
  };
}
