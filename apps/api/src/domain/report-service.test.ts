import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkAuditChain, createPool, runMigrations, withTenant } from '@reporting/db';
import { contentHash, parse, type TokenDocument } from '@reporting/tokens';

import { TestOnlyFixedTokenStepUp, type Actor } from '../auth.js';
import { ApiError } from '../errors.js';
import { APPROVAL_AUTHORITY_ROLE } from '../roles.js';
import { createDelegation } from './delegation-service.js';
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
  let twoVersionId: string;
  let threeVersionId: string;
  let twoPolicyId: string;
  let otherReportId: string;
  const stepUp = new TestOnlyFixedTokenStepUp(STEP_UP_TOKEN);

  function deps(): { pool: pg.Pool; stepUp: TestOnlyFixedTokenStepUp } {
    return { pool, stepUp };
  }

  /**
   * Seeds one tenant: its people, three templates, and the rules those templates resolve
   * to. The rules are seeded rather than assumed because since ADR-0010 a report cannot be
   * created without one — a tenant with templates and no policy is a tenant that cannot
   * write reports, which is a state worth having a migration for rather than a default.
   */
  async function seedTenant(
    orgId: string,
    label: string,
  ): Promise<{
    versionId: string;
    twoVersionId: string;
    threeVersionId: string;
    defaultPolicyId: string;
    twoPolicyId: string;
  }> {
    await owner.query('begin');
    await owner.query("select set_config('app.org_id', $1, true)", [orgId]);
    await owner.query('insert into org (id, name) values ($1, $2)', [orgId, `Radiology ${label}`]);
    // Three people: the author, a second attending, and someone an absent attending
    // can be covered by. Cross-cover needs a real third identity to point at.
    for (const suffix of ['', '-2', '-3']) {
      // The author also holds the approval authority: in a small group the people who
      // decide how many signatures a report needs are the people who write them.
      // `approver` and `cover` deliberately do not, so the refusals have a real subject.
      const roles = suffix === '' ? ['radiologist', APPROVAL_AUTHORITY_ROLE] : ['radiologist'];

      await owner.query(
        'insert into app_user (org_id, idp_subject, display_name, roles) values ($1, $2, $3, $4)',
        [orgId, `subject-${label}${suffix}`, `Dr ${label}${suffix}`, roles],
      );
    }

    const author = await owner.query<{ id: string }>(
      'select id from app_user where idp_subject = $1',
      [`subject-${label}`],
    );
    const authorId = author.rows[0]?.id ?? '';

    const parsed = parse(BODY);
    const document: TokenDocument = { schema_version: 1, tokens: parsed.tokens };

    /** One template and its pinned version. Same body every time; only the identity differs. */
    async function addVersion(name: string): Promise<{ templateId: string; versionId: string }> {
      const template = await owner.query<{ id: string }>(
        `insert into template (org_id, name, scope, modality, type, provenance)
         values ($1, $2, 'AlemHealth', 'XR', 'FREE_TEXT', $3) returning id`,
        [orgId, `${name} ${label}`, JSON.stringify({ class: 'unknown' })],
      );
      const templateId = template.rows[0]?.id ?? '';

      const version = await owner.query<{ id: string }>(
        `insert into template_version
           (org_id, template_id, version, body, token_stream, fields, content_hash)
         values ($1, $2, 1, $3, $4, $5, $6) returning id`,
        [
          orgId,
          templateId,
          BODY,
          JSON.stringify(document),
          JSON.stringify(parsed.fields),
          contentHash(document),
        ],
      );

      return { templateId, versionId: version.rows[0]?.id ?? '' };
    }

    /** A rule, written the way the API writes one: by a clinical lead, with a reason. */
    async function addPolicy(
      key: { readonly templateId?: string },
      approvalsRequired: number,
    ): Promise<string> {
      const policy = await owner.query<{ id: string }>(
        `insert into approval_policy
           (org_id, template_id, approvals_required, rationale, created_by_user_id)
         values ($1, $2, $3, $4, $5) returning id`,
        [
          orgId,
          key.templateId ?? null,
          approvalsRequired,
          'Seeded for the vertical slice.',
          authorId,
        ],
      );

      return policy.rows[0]?.id ?? '';
    }

    // The organisation default. Everything without a rule of its own resolves here, which
    // is the difference between a fallback and a rule: this one is a row somebody wrote.
    const defaultPolicyId = await addPolicy({}, 1);

    const solo = await addVersion('XR Chest');
    const two = await addVersion('CT Head');
    const three = await addVersion('MRI Spine');

    const twoPolicyId = await addPolicy({ templateId: two.templateId }, 2);
    await addPolicy({ templateId: three.templateId }, 3);

    await owner.query('commit');

    return {
      versionId: solo.versionId,
      twoVersionId: two.versionId,
      threeVersionId: three.versionId,
      defaultPolicyId,
      twoPolicyId,
    };
  }

  beforeAll(async () => {
    if (ownerUrl === undefined || appUrl === undefined) return;

    await runMigrations(ownerUrl);

    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    const seeded = await seedTenant(ORG, 'A');
    versionId = seeded.versionId;
    twoVersionId = seeded.twoVersionId;
    threeVersionId = seeded.threeVersionId;
    twoPolicyId = seeded.twoPolicyId;

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
      `insert into report (org_id, study_id, template_version_id, author_id, current_hash,
                           approval_policy_id)
       values ($1, $2, $3, $4, 'sha256:other-tenant', $5) returning id`,
      [
        OTHER_ORG,
        otherStudy.rows[0]?.id ?? '',
        otherVersion.versionId,
        otherUser.rows[0]?.id ?? '',
        otherVersion.defaultPolicyId,
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
    /** A report on the template whose policy says two. The number is not passed in. */
    async function twoSignatureReport(): Promise<{ id: string; currentHash: string }> {
      const report = await createReport(deps(), {
        actor,
        templateVersionId: twoVersionId,
        studyInstanceUid: `1.2.840.${randomUUID()}`,
        modality: 'XR',
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

    /**
     * Cover is authority, not a name in a request body (0005), so every cross-cover test
     * needs a grant first. Two hours is deliberate: long enough to survive the test, short
     * enough that "expired" is a date this file can construct rather than wait for.
     */
    async function coverFor(from: typeof approver, hours = 2): Promise<{ id: string }> {
      const granted = await createDelegation(deps(), {
        actor,
        fromUserId: from.userId,
        toUserId: cover.userId,
        expiresAt: new Date(Date.now() + hours * 3_600_000).toISOString(),
      });

      return { id: granted.id };
    }

    it('counts a cross-cover signature and records who it covers for', async () => {
      const report = await twoSignatureReport();
      const delegation = await coverFor(approver);

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

      // The client has to be able to say who was covered for; recording it only in
      // the database would leave the approve screen unable to explain the signature.
      expect(signed.signatures.map((signature) => signature.role)).toEqual(['author', 'delegate']);
      expect(signed.signatures[0]?.on_behalf_of).toBeNull();
      expect(signed.signatures[1]?.on_behalf_of).toBe(approver.userId);

      await withTenant(pool, { orgId: ORG }, async (tx) => {
        const row = await tx.query<{
          role: string;
          on_behalf_of: string | null;
          delegation_id: string | null;
        }>(
          `select role, on_behalf_of, delegation_id
             from signature where report_id = $1 and actor_id = $2`,
          [report.id, cover.userId],
        );

        expect(row.rows[0]?.role).toBe('delegate');
        expect(row.rows[0]?.on_behalf_of).toBe(approver.userId);
        // The signature says who it covers for and cites what entitled it. Both, because
        // the claim and the authority are separate facts and the trail has to hold each.
        expect(row.rows[0]?.delegation_id).toBe(delegation.id);
      });
    });

    it('refuses cross-cover when no delegation is in force', async () => {
      const report = await twoSignatureReport();
      const submitted = await signReport(deps(), {
        actor,
        reportId: report.id,
        ifMatch: report.currentHash,
        stepUpAssertion: STEP_UP_TOKEN,
      });

      // Naming whom you cover for is not the same as being entitled to. Without a grant
      // this is a signature asserting its own authority — the case the table exists for.
      //
      // The pair is reversed on purpose: an earlier test grants approver → cover, and a
      // grant is evidence, so it cannot be deleted to make this test's premise true.
      // Nothing has ever been granted cover → approver, which is what this asserts.
      await expect(
        signReport(deps(), {
          actor: approver,
          reportId: report.id,
          ifMatch: submitted.current_hash,
          stepUpAssertion: STEP_UP_TOKEN,
          onBehalfOf: cover.userId,
        }),
      ).rejects.toMatchObject({ code: 'no_active_delegation' });
    });

    it('refuses cross-cover once the grant has expired', async () => {
      const report = await twoSignatureReport();
      const submitted = await signReport(deps(), {
        actor,
        reportId: report.id,
        ifMatch: report.currentHash,
        stepUpAssertion: STEP_UP_TOKEN,
      });

      // Granted, then made historical. The row stays — it is evidence that cover existed —
      // but the clock is what makes it authority, and the clock has moved past it.
      //
      // Backdated on the owner connection on purpose: the application role has `select,
      // insert` only, so a running service cannot move a grant's window. Production code
      // has no way to do what this test does, which is the property being relied on.
      await coverFor(approver);

      await owner.query('begin');
      await owner.query("select set_config('app.org_id', $1, true)", [ORG]);
      // Every grant for this pair, not just this one: an earlier test left a live grant
      // between the same two people, and `findLiveDelegation` would rightly find it. The
      // premise here is "no cover from this person is in force", so the fixture has to
      // make that true rather than expire one row and hope.
      const backdated = await owner.query(
        `update delegation
            set starts_at  = now() - interval '3 days',
                expires_at = now() - interval '1 day'
          where org_id = $1 and from_user_id = $2 and to_user_id = $3`,
        [ORG, approver.userId, cover.userId],
      );
      await owner.query('commit');

      // A fixture that silently did nothing would make this test pass for the wrong
      // reason: the signing refusal below has to be caused by the clock, not by an
      // `update` that matched no rows under row-level security.
      expect(backdated.rowCount).toBeGreaterThanOrEqual(1);

      await expect(
        signReport(deps(), {
          actor: cover,
          reportId: report.id,
          ifMatch: submitted.current_hash,
          stepUpAssertion: STEP_UP_TOKEN,
          onBehalfOf: approver.userId,
        }),
      ).rejects.toMatchObject({ code: 'no_active_delegation' });
    });

    it('refuses a delegation granted by someone with no authority to lend it', async () => {
      // `cover` holds no clinical_lead role, so they may lend their own authority but not
      // approver's. Otherwise cover is one colleague vouching for another.
      await expect(
        createDelegation(deps(), {
          actor: cover,
          fromUserId: approver.userId,
          toUserId: actor.userId,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('refuses an open-ended or already-dead grant', async () => {
      await expect(
        createDelegation(deps(), {
          actor: approver,
          toUserId: cover.userId,
          expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString(),
        }),
      ).rejects.toMatchObject({ code: 'invalid_request' });

      await expect(
        createDelegation(deps(), {
          actor: approver,
          toUserId: cover.userId,
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    });

    it('records the grant in the audit trail', async () => {
      const delegation = await coverFor(approver);

      await withTenant(pool, { orgId: ORG }, async (tx) => {
        const row = await tx.query<{ action: string; meta: { to_user_id?: string } }>(
          "select action, meta from audit_event where subject_id = $1 and action = 'delegation.granted'",
          [delegation.id],
        );

        expect(row.rows[0]?.meta.to_user_id).toBe(cover.userId);
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

    it('refuses a delegate signature that names a person but cites no grant', async () => {
      const report = await twoSignatureReport();

      // The service cannot produce this row — it resolves a grant before inserting. This
      // is the check that still holds when someone writes the insert by hand, which is
      // the whole reason the guarantee lives in the trigger and not in the service.
      await expect(
        withTenant(pool, { orgId: ORG, actorId: cover.userId }, async (tx) => {
          const revision = await tx.query<{ id: string; content_hash: string }>(
            'select id, content_hash from report_revision where report_id = $1 order by revision desc limit 1',
            [report.id],
          );

          await tx.query(
            `insert into signature
               (org_id, report_id, revision_id, actor_id, role, method, content_hash, on_behalf_of)
             values ($1, $2, $3, $4, 'delegate', 'sso_step_up', $5, $6)`,
            [
              ORG,
              report.id,
              revision.rows[0]?.id ?? '',
              cover.userId,
              revision.rows[0]?.content_hash ?? '',
              approver.userId,
            ],
          );
        }),
      ).rejects.toThrow(/must cite the delegation/i);
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

    /**
     * The middle of a three-way approval is a state the worklist has to render, and
     * it is the only branch of `signReport` that neither completes nor submits. A
     * report sitting at two of three must be visibly waiting, not silently stuck.
     */
    it('records a countersignature that does not yet complete a three-way approval', async () => {
      const report = await createReport(deps(), {
        actor,
        templateVersionId: threeVersionId,
        studyInstanceUid: `1.2.840.${randomUUID()}`,
        modality: 'XR',
      });

      const submitted = await signReport(deps(), {
        actor,
        reportId: report.id,
        ifMatch: report.current_hash,
        stepUpAssertion: STEP_UP_TOKEN,
      });

      expect(submitted.state).toBe('submitted');
      expect(submitted.signatures).toHaveLength(1);
      expect(submitted.approvals_remaining).toBe(2);

      const countersigned = await signReport(deps(), {
        actor: approver,
        reportId: report.id,
        ifMatch: submitted.current_hash,
        stepUpAssertion: STEP_UP_TOKEN,
      });

      expect(countersigned.state).toBe('submitted');
      expect(countersigned.signed_at).toBeNull();
      // The number the worklist renders: one more person, after this one.
      expect(countersigned.approvals_remaining).toBe(1);
      expect(countersigned.signatures.map((signature) => signature.role)).toEqual([
        'author',
        'approver',
      ]);
      expect(await auditActions(report.id)).toEqual([
        'report.created',
        'report.submitted',
        'report.countersigned',
      ]);

      const signed = await signReport(deps(), {
        actor: cover,
        reportId: report.id,
        ifMatch: countersigned.current_hash,
        stepUpAssertion: STEP_UP_TOKEN,
      });

      expect(signed.state).toBe('signed');
      expect(signed.signatures).toHaveLength(3);
      expect(await auditActions(report.id)).toEqual([
        'report.created',
        'report.submitted',
        'report.countersigned',
        'report.signed',
      ]);
    });

    /**
     * A signature approves the words it was placed over. Once a returned report is
     * edited the revision changes, and the earlier signatures become history rather
     * than progress — otherwise the client shows a fresh revision as already signed.
     */
    it('does not carry signatures forward onto the revision that replaced them', async () => {
      const report = await twoSignatureReport();

      const submitted = await signReport(deps(), {
        actor,
        reportId: report.id,
        ifMatch: report.currentHash,
        stepUpAssertion: STEP_UP_TOKEN,
      });

      expect(submitted.signatures).toHaveLength(1);

      // The attending sends it back; the author edits, which is a new revision.
      await withTenant(pool, { orgId: ORG }, async (tx) => {
        await tx.query("update report set state = 'returned' where id = $1", [report.id]);
        await tx.query("update report set state = 'draft' where id = $1", [report.id]);
      });

      const revised = await saveDraft(deps(), {
        actor,
        reportId: report.id,
        ifMatch: submitted.current_hash,
        fieldValues: { [IMPRESSION_KEY]: 'No acute abnormality.' },
      });

      expect(revised.revision).toBe(2);
      expect(revised.signatures).toEqual([]);

      // The old signature is still evidence; it is simply not an approval of this text.
      await withTenant(pool, { orgId: ORG }, async (tx) => {
        const rows = await tx.query(
          'select revision_id from signature where report_id = $1 and actor_id = $2',
          [report.id, actor.userId],
        );

        expect(rows.rowCount).toBe(1);
      });
    });

    /**
     * The bar is a rule, not a field on the request (ADR-0010). It used to be a free field
     * gated by a role, which answered "may this person decide" and recorded nothing about
     * what was decided. Now the create body has nowhere to put a number at all: the only
     * way to change what a report requires is to write a rule, which is tenant-scoped,
     * audited, and the same for everybody.
     */
    it('takes the requirement from the tenant’s rules, not from the caller', async () => {
      const report = await createReport(deps(), {
        // No approval authority. That no longer matters for creating: it matters for
        // writing the rule, which is the endpoint in `approval-policy.test.ts`.
        actor: cover,
        templateVersionId: twoVersionId,
        studyInstanceUid: `1.2.840.${randomUUID()}`,
        modality: 'XR',
      });

      expect(report.approvals_required).toBe(2);
      expect(report.approvals_remaining).toBe(2);
    });

    it('still lets anyone create a solo-sign report', async () => {
      const report = await createReport(deps(), {
        actor: cover,
        templateVersionId: versionId,
        studyInstanceUid: `1.2.840.${randomUUID()}`,
        modality: 'XR',
      });

      expect(report.approvals_required).toBe(1);
      expect(report.approvals_remaining).toBe(1);
    });

    it('records what the report was asked to be in the creation event', async () => {
      const report = await twoSignatureReport();

      const meta = await withTenant(pool, { orgId: ORG }, async (tx) => {
        const rows = await tx.query<{
          meta: { approvals_required?: number; approval_policy_id?: string };
        }>("select meta from audit_event where subject_id = $1 and action = 'report.created'", [
          report.id,
        ]);

        return rows.rows[0]?.meta;
      });

      // Evidence, not configuration: a later policy change must not be readable back
      // onto a report that was signed under the old one. The policy id is the rest of the
      // answer — not just "two signatures" but the rule that said two.
      expect(meta?.approvals_required).toBe(2);
      expect(meta?.approval_policy_id).toBe(twoPolicyId);
    });
  });
});
