import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkAuditChain, createPool, runMigrations, withTenant } from '@reporting/db';
import { contentHash, parse, type TokenDocument } from '@reporting/tokens';

import { TestOnlyFixedTokenStepUp, type Actor } from '../auth.js';
import { ApiError } from '../errors.js';
import { createReport, getReport, saveDraft, signReport } from './report-service.js';

/**
 * The vertical slice, against a real PostgreSQL through the *runtime* role.
 *
 * Two things are being tested that a mock cannot test:
 *
 * 1. that the sign transaction is a transaction — a failure leaves no signature,
 *    no state change and no audit event;
 * 2. that the evidence invariants live in the database, by attempting the write
 *    the service would never make and watching the database refuse it.
 */
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const enabled = ownerUrl !== undefined && appUrl !== undefined;

// Fresh tenants per run: no 	runcate, so this suite can run alongside any other
// that touches the same test database. Leftover rows belong to other tenants and
// are invisible through RLS — which is the property under test.
const ORG = randomUUID();
const OTHER_ORG = randomUUID();

const STEP_UP_TOKEN = 'test-step-up-token';

const BODY = [
  'EXAM:',
  'Chest X-ray, frontal view.',
  '',
  'FINDINGS:',
  'The lungs are clear. No consolidation.',
  '',
  'IMPRESSION:',
  '[___]',
  '',
].join('\n');

/**
 * Field keys are derived, not chosen: `section__placeholder`, slugged. Asserting
 * against a literal key would couple this test to a naming rule it does not own.
 */
const IMPRESSION_KEY = parse(BODY).fields[0]?.key ?? 'impression__blank';

describe.skipIf(!enabled)('report vertical slice', () => {
  let owner: pg.Client;
  let pool: pg.Pool;
  let actor: Actor;
  let approver: Actor;
  let cover: Actor;
  let versionId: string;
  let otherReportId: string;
  const stepUp = new TestOnlyFixedTokenStepUp(STEP_UP_TOKEN);

  function deps(): { pool: pg.Pool; stepUp: TestOnlyFixedTokenStepUp } {
    return { pool, stepUp };
  }

  /** Seeds one tenant's user, template and pinned version. */
  async function seedTenant(orgId: string, label: string): Promise<{ versionId: string }> {
    await owner.query('begin');
    await owner.query("select set_config('app.org_id', $1, true)", [orgId]);
    await owner.query('insert into org (id, name) values ($1, $2)', [orgId, `Radiology ${label}`]);
    // Three people: the author, a second attending, and someone an absent attending
    // can be covered by. Cross-cover needs a real third identity to point at.
    for (const suffix of ['', '-2', '-3']) {
      await owner.query(
        'insert into app_user (org_id, idp_subject, display_name, roles) values ($1, $2, $3, $4)',
        [orgId, `subject-${label}${suffix}`, `Dr ${label}${suffix}`, ['radiologist']],
      );
    }

    const parsed = parse(BODY);
    const document: TokenDocument = { schema_version: 1, tokens: parsed.tokens };

    const template = await owner.query<{ id: string }>(
      `insert into template (org_id, name, scope, modality, type, provenance)
       values ($1, $2, 'AlemHealth', 'XR', 'FREE_TEXT', $3) returning id`,
      [orgId, `XR Chest ${label}`, JSON.stringify({ class: 'unknown' })],
    );

    const version = await owner.query<{ id: string }>(
      `insert into template_version
         (org_id, template_id, version, body, token_stream, fields, content_hash)
       values ($1, $2, 1, $3, $4, $5, $6) returning id`,
      [
        orgId,
        template.rows[0]?.id ?? '',
        BODY,
        JSON.stringify(document),
        JSON.stringify(parsed.fields),
        contentHash(document),
      ],
    );

    await owner.query('commit');

    return { versionId: version.rows[0]?.id ?? '' };
  }

  beforeAll(async () => {
    if (ownerUrl === undefined || appUrl === undefined) return;

    await runMigrations(ownerUrl);

    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    versionId = (await seedTenant(ORG, 'A')).versionId;

    // A second tenant, with one report of its own, to prove the slice cannot reach
    // it even holding a valid id.
    const otherVersion = await seedTenant(OTHER_ORG, 'B');
    await owner.query('begin');
    await owner.query("select set_config('app.org_id', $1, true)", [OTHER_ORG]);
    const otherUser = await owner.query<{ id: string }>(
      'select id from app_user where idp_subject = $1',
      ['subject-B'],
    );
    const otherStudy = await owner.query<{ id: string }>(
      `insert into study (org_id, study_instance_uid, modality)
       values ($1, '1.2.840.other', 'XR') returning id`,
      [OTHER_ORG],
    );
    const otherReport = await owner.query<{ id: string }>(
      `insert into report (org_id, study_id, template_version_id, author_id, current_hash)
       values ($1, $2, $3, $4, 'sha256:other-tenant') returning id`,
      [
        OTHER_ORG,
        otherStudy.rows[0]?.id ?? '',
        otherVersion.versionId,
        otherUser.rows[0]?.id ?? '',
      ],
    );
    otherReportId = otherReport.rows[0]?.id ?? '';
    await owner.query(
      `insert into report_revision
         (org_id, report_id, revision, sections, field_values, content_hash, author_id, reason)
       values ($1, $2, 1, '{}', '{}', 'sha256:other-tenant', $3, 'draft_save')`,
      [OTHER_ORG, otherReportId, otherUser.rows[0]?.id ?? ''],
    );
    await owner.query('commit');

    await owner.query('begin');
    await owner.query("select set_config('app.org_id', $1, true)", [ORG]);
    const user = await owner.query<{ id: string; idp_subject: string; roles: string[] }>(
      'select id, idp_subject, roles from app_user where idp_subject = $1',
      ['subject-A'],
    );
    // Read inside the tenant transaction: `set_config(..., true)` is reverted at
    // commit, and a policy evaluation afterwards raises rather than returning rows.
    const others = await owner.query<{ id: string; idp_subject: string; roles: string[] }>(
      "select id, idp_subject, roles from app_user where idp_subject in ('subject-A-2', 'subject-A-3') order by idp_subject",
    );
    await owner.query('commit');

    const asActor = (row: { id: string; idp_subject: string; roles: string[] }): Actor => ({
      orgId: ORG,
      userId: row.id,
      idpSubject: row.idp_subject,
      roles: row.roles,
    });

    actor = asActor(user.rows[0] ?? { id: '', idp_subject: '', roles: [] });

    approver = asActor(others.rows[0] ?? { id: '', idp_subject: '', roles: [] });
    cover = asActor(others.rows[1] ?? { id: '', idp_subject: '', roles: [] });

    pool = createPool(appUrl, 'reporting-api-test');
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await owner?.end();
  });

  async function newReport(): Promise<{ id: string; currentHash: string }> {
    const report = await createReport(deps(), {
      actor,
      templateVersionId: versionId,
      studyInstanceUid: `1.2.840.${Math.random().toString(36).slice(2)}`,
      modality: 'XR',
    });

    return { id: report.id, currentHash: report.current_hash };
  }

  async function auditActions(reportId: string): Promise<string[]> {
    return withTenant(pool, { orgId: ORG }, async (tx) => {
      const rows = await tx.query<{ action: string }>(
        "select action from audit_event where subject_id = $1 and subject_type = 'report' order by id",
        [reportId],
      );

      return rows.rows.map((row) => row.action);
    });
  }

  it('creates a draft pinned to a template version, with revision 1 and an audit event', async () => {
    const report = await createReport(deps(), {
      actor,
      templateVersionId: versionId,
      studyInstanceUid: '1.2.840.1',
      accession: 'ACC-1',
      modality: 'XR',
    });

    expect(report.state).toBe('draft');
    expect(report.revision).toBe(1);
    expect(report.template_version_id).toBe(versionId);
    expect(report.current_hash).toBe(contentHash(report.document));
    expect(await auditActions(report.id)).toEqual(['report.created']);
  });

  it('appends a revision on autosave and moves the hash', async () => {
    const report = await newReport();

    const saved = await saveDraft(deps(), {
      actor,
      reportId: report.id,
      ifMatch: report.currentHash,
      fieldValues: { [IMPRESSION_KEY]: 'No acute abnormality.' },
    });

    expect(saved.revision).toBe(2);
    expect(saved.current_hash).not.toBe(report.currentHash);
    expect(saved.field_values[IMPRESSION_KEY]).toBe('No acute abnormality.');
    expect(await auditActions(report.id)).toEqual(['report.created', 'report.draft_saved']);
  });

  it('refuses a stale If-Match and writes nothing', async () => {
    const report = await newReport();

    await expect(
      saveDraft(deps(), {
        actor,
        reportId: report.id,
        ifMatch: 'sha256:' + '0'.repeat(64),
        fieldValues: {},
      }),
    ).rejects.toBeInstanceOf(ApiError);

    const reread = await getReport(deps(), actor, report.id);
    expect(reread.revision).toBe(1);
    expect(await auditActions(report.id)).toEqual(['report.created']);
  });

  it('refuses a value for a field the template does not have', async () => {
    const report = await newReport();

    await expect(
      saveDraft(deps(), {
        actor,
        reportId: report.id,
        ifMatch: report.currentHash,
        fieldValues: { not_a_field: 'x' },
      }),
    ).rejects.toThrow(/Unknown field keys/);
  });

  it('refuses to sign without a satisfied step-up', async () => {
    const report = await newReport();

    await expect(
      signReport(deps(), {
        actor,
        reportId: report.id,
        ifMatch: report.currentHash,
        stepUpAssertion: undefined,
      }),
    ).rejects.toThrow(/step-up assertion was presented|no step-up assertion/i);

    const reread = await getReport(deps(), actor, report.id);
    expect(reread.state).toBe('draft');
    expect(await auditActions(report.id)).toEqual(['report.created']);
  });

  it('fails closed when no step-up verifier is configured at all', async () => {
    const report = await newReport();

    await expect(
      signReport(
        { pool, stepUp: { available: false, description: 'none', verify: async () => null } },
        {
          actor,
          reportId: report.id,
          ifMatch: report.currentHash,
          stepUpAssertion: STEP_UP_TOKEN,
        },
      ),
    ).rejects.toThrow(/Signing is disabled/);
  });

  it('signs the current revision, and records the signature and the audit event', async () => {
    const report = await newReport();
    const saved = await saveDraft(deps(), {
      actor,
      reportId: report.id,
      ifMatch: report.currentHash,
      fieldValues: { [IMPRESSION_KEY]: 'No acute abnormality.' },
    });

    const signed = await signReport(deps(), {
      actor,
      reportId: report.id,
      ifMatch: saved.current_hash,
      stepUpAssertion: STEP_UP_TOKEN,
    });

    expect(signed.state).toBe('signed');
    expect(signed.signed_at).not.toBeNull();
    expect(await auditActions(report.id)).toEqual([
      'report.created',
      'report.draft_saved',
      'report.signed',
    ]);

    await withTenant(pool, { orgId: ORG }, async (tx) => {
      const signature = await tx.query<{ content_hash: string; role: string; method: string }>(
        'select content_hash, role, method from signature where report_id = $1',
        [report.id],
      );

      expect(signature.rowCount).toBe(1);
      expect(signature.rows[0]?.content_hash).toBe(signed.current_hash);
      expect(signature.rows[0]?.role).toBe('author');
      expect(signature.rows[0]?.method).toBe('sso_step_up');
    });

    // And the second attempt is refused rather than producing a second signature.
    await expect(
      signReport(deps(), {
        actor,
        reportId: report.id,
        ifMatch: signed.current_hash,
        stepUpAssertion: STEP_UP_TOKEN,
      }),
    ).rejects.toMatchObject({ code: 'report_already_signed' });
  });

  it('keeps the audit chain intact across the slice', async () => {
    const report = await newReport();
    await signReport(deps(), {
      actor,
      reportId: report.id,
      ifMatch: report.currentHash,
      stepUpAssertion: STEP_UP_TOKEN,
    });

    await withTenant(pool, { orgId: ORG }, async (tx) => {
      const check = await checkAuditChain(tx, ORG);
      expect(check.ok).toBe(true);
      expect(check.firstBrokenIndex).toBeNull();
    });
  });

  /**
   * The contract test proper. It does not call the service: it performs the write
   * the service is supposed to prevent, in the same shape a future code path
   * might, and asserts the database refuses to commit it.
   */
  it('refuses to commit a signed report with no signature', async () => {
    const report = await newReport();
    const client = await pool.connect();

    try {
      await client.query('begin');
      await client.query("select set_config('app.org_id', $1, true)", [ORG]);
      await client.query("update report set state = 'signed' where id = $1", [report.id]);

      await expect(client.query('commit')).rejects.toThrow(/signed but has no signature/i);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }

    const reread = await getReport(deps(), actor, report.id);
    expect(reread.state).toBe('draft');
  });

  it('refuses a signature whose hash is not the revision’s', async () => {
    const report = await newReport();

    await expect(
      withTenant(pool, { orgId: ORG, actorId: actor.userId }, async (tx) => {
        const revision = await tx.query<{ id: string }>(
          'select id from report_revision where report_id = $1 order by revision desc limit 1',
          [report.id],
        );

        await tx.query(
          `insert into signature
             (org_id, report_id, revision_id, actor_id, role, method, content_hash)
           values ($1, $2, $3, $4, 'author', 'sso_step_up', $5)`,
          [ORG, report.id, revision.rows[0]?.id ?? '', actor.userId, 'sha256:' + 'f'.repeat(64)],
        );
      }),
    ).rejects.toThrow(/must attest the content hash/i);
  });

  it('cannot reach another tenant’s report by id', async () => {
    await expect(getReport(deps(), actor, otherReportId)).rejects.toThrow(/No report/);
  });

  /**
   * D3: N-of-M with cross-cover. `approvals_required` counts signatures, and the
   * author's is one of them.
   */
  describe('multi-signature approval', () => {
    async function twoSignatureReport(): Promise<{ id: string; currentHash: string }> {
      const report = await createReport(deps(), {
        actor,
        templateVersionId: versionId,
        studyInstanceUid: `1.2.840.${randomUUID()}`,
        modality: 'XR',
        approvalsRequired: 2,
      });

      return { id: report.id, currentHash: report.current_hash };
    }

    it('holds the report at submitted until the second signature arrives', async () => {
      const report = await twoSignatureReport();

      const submitted = await signReport(deps(), {
        actor,
        reportId: report.id,
        ifMatch: report.currentHash,
        stepUpAssertion: STEP_UP_TOKEN,
      });

      expect(submitted.state).toBe('submitted');
      expect(submitted.approvals_required).toBe(2);
      expect(submitted.signatures).toHaveLength(1);
      expect(submitted.signed_at).toBeNull();
      expect(await auditActions(report.id)).toEqual(['report.created', 'report.submitted']);

      const signed = await signReport(deps(), {
        actor: approver,
        reportId: report.id,
        ifMatch: submitted.current_hash,
        stepUpAssertion: STEP_UP_TOKEN,
      });

      expect(signed.state).toBe('signed');
      expect(signed.signatures.map((signature) => signature.role)).toEqual(['author', 'approver']);
      expect(await auditActions(report.id)).toEqual([
        'report.created',
        'report.submitted',
        'report.signed',
      ]);
    });

    it('refuses an approver while the report is still a draft', async () => {
      const report = await twoSignatureReport();

      await expect(
        signReport(deps(), {
          actor: approver,
          reportId: report.id,
          ifMatch: report.currentHash,
          stepUpAssertion: STEP_UP_TOKEN,
        }),
      ).rejects.toMatchObject({ code: 'report_not_submitted' });
    });

    it('refuses a second signature from the same person', async () => {
      const report = await twoSignatureReport();
      const submitted = await signReport(deps(), {
        actor,
        reportId: report.id,
        ifMatch: report.currentHash,
        stepUpAssertion: STEP_UP_TOKEN,
      });

      await expect(
        signReport(deps(), {
          actor,
          reportId: report.id,
          ifMatch: submitted.current_hash,
          stepUpAssertion: STEP_UP_TOKEN,
        }),
      ).rejects.toMatchObject({ code: 'already_signed' });
    });

    it('counts a cross-cover signature and records who it covers for', async () => {
      const report = await twoSignatureReport();
      const submitted = await signReport(deps(), {
        actor,
        reportId: report.id,
        ifMatch: report.currentHash,
        stepUpAssertion: STEP_UP_TOKEN,
      });

      const signed = await signReport(deps(), {
        actor: cover,
        reportId: report.id,
        ifMatch: submitted.current_hash,
        stepUpAssertion: STEP_UP_TOKEN,
        onBehalfOf: approver.userId,
      });

      expect(signed.state).toBe('signed');

      await withTenant(pool, { orgId: ORG }, async (tx) => {
        const row = await tx.query<{ role: string; on_behalf_of: string | null }>(
          'select role, on_behalf_of from signature where report_id = $1 and actor_id = $2',
          [report.id, cover.userId],
        );

        expect(row.rows[0]?.role).toBe('delegate');
        expect(row.rows[0]?.on_behalf_of).toBe(approver.userId);
      });
    });

    it('refuses a delegate signature that names nobody', async () => {
      const report = await twoSignatureReport();

      await expect(
        withTenant(pool, { orgId: ORG, actorId: cover.userId }, async (tx) => {
          const revision = await tx.query<{ id: string; content_hash: string }>(
            'select id, content_hash from report_revision where report_id = $1 order by revision desc limit 1',
            [report.id],
          );

          await tx.query(
            `insert into signature
               (org_id, report_id, revision_id, actor_id, role, method, content_hash)
             values ($1, $2, $3, $4, 'delegate', 'sso_step_up', $5)`,
            [
              ORG,
              report.id,
              revision.rows[0]?.id ?? '',
              cover.userId,
              revision.rows[0]?.content_hash ?? '',
            ],
          );
        }),
      ).rejects.toThrow(/must name the person/i);
    });

    it('refuses to commit signed with fewer signatures than required', async () => {
      const report = await twoSignatureReport();
      const submitted = await signReport(deps(), {
        actor,
        reportId: report.id,
        ifMatch: report.currentHash,
        stepUpAssertion: STEP_UP_TOKEN,
      });

      expect(submitted.state).toBe('submitted');

      const client = await pool.connect();

      try {
        await client.query('begin');
        await client.query("select set_config('app.org_id', $1, true)", [ORG]);
        await client.query("update report set state = 'signed' where id = $1", [report.id]);

        await expect(client.query('commit')).rejects.toThrow(/but requires 2/i);
      } finally {
        await client.query('rollback').catch(() => undefined);
        client.release();
      }
    });
  });
});
