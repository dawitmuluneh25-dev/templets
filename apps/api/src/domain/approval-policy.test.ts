import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool, runMigrations, withTenant } from '@reporting/db';
import { contentHash, parse, type TokenDocument } from '@reporting/tokens';

import { TestOnlyFixedTokenStepUp, type Actor } from '../auth.js';
import { APPROVAL_AUTHORITY_ROLE } from '../roles.js';
import { createApprovalPolicy, listApprovalPolicies } from './approval-policy.js';
import { createReport, getReport } from './report-service.js';

/**
 * How many signatures a report needs, resolved from rules rather than asked for
 * (ADR-0010), against a real PostgreSQL through the runtime role.
 *
 * The properties being tested are the ones a mock cannot reach:
 *
 * 1. that resolution order is a total order — narrowest rule, then newest row — and
 *    therefore that two people writing the same exam get the same bar;
 * 2. that the number is snapshotted onto the report, so changing a rule today cannot
 *    re-bar a report that was created under yesterday's;
 * 3. that the tables refuse the writes the service would never make, including a report
 *    that cites a rule which does not say what the report claims.
 */
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const enabled = ownerUrl !== undefined && appUrl !== undefined;

// Fresh tenants per run: leftover rows belong to other tenants and are invisible through
// RLS, which is the property under test rather than an inconvenience.
const ORG = randomUUID();
/** A tenant with templates and no rules at all: the state a fresh deployment boots into. */
const UNSERVED_ORG = randomUUID();

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

describe.skipIf(!enabled)('approval policy', () => {
  let owner: pg.Client;
  let pool: pg.Pool;
  const stepUp = new TestOnlyFixedTokenStepUp('test-step-up-token');

  /**
   * Runs `fn` inside a tenant-scoped transaction on the owning connection.
   *
   * Needed because `FORCE ROW LEVEL SECURITY` applies to the owner too: seeding a row
   * without `app.org_id` set does not quietly work, it raises. That is the tenancy line
   * doing its job, including against whoever is writing the test.
   */
  async function asTenant<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    await owner.query('begin');
    await owner.query("select set_config('app.org_id', $1, true)", [orgId]);

    try {
      const result = await fn();
      await owner.query('commit');
      return result;
    } catch (error) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }
  }

  /** Two people: one who may set the bar, one who may not. */
  async function seedPeople(
    orgId: string,
    label: string,
  ): Promise<{ lead: Actor; radiologist: Actor }> {
    return asTenant(orgId, async () => {
      const people: Record<string, Actor> = {};

      for (const [key, roles] of [
        ['lead', ['radiologist', APPROVAL_AUTHORITY_ROLE]],
        ['radiologist', ['radiologist']],
      ] as const) {
        const inserted = await owner.query<{ id: string }>(
          `insert into app_user (org_id, idp_subject, display_name, roles)
           values ($1, $2, $3, $4) returning id`,
          [orgId, `subject-${label}-${key}`, `Dr ${label} ${key}`, roles],
        );

        people[key] = {
          orgId,
          userId: inserted.rows[0]?.id ?? '',
          idpSubject: `subject-${label}-${key}`,
          roles,
        };
      }

      return { lead: people.lead as Actor, radiologist: people.radiologist as Actor };
    });
  }

  async function seedTemplate(orgId: string, name: string): Promise<string> {
    const parsed = parse(BODY);
    const document: TokenDocument = { schema_version: 1, tokens: parsed.tokens };

    return asTenant(orgId, async () => {
      const template = await owner.query<{ id: string }>(
        `insert into template (org_id, name, scope, modality, type, provenance)
         values ($1, $2, 'AlemHealth', 'XR', 'FREE_TEXT', $3) returning id`,
        [orgId, name, JSON.stringify({ class: 'unknown' })],
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

      return version.rows[0]?.id ?? '';
    });
  }

  async function writePolicy(
    orgId: string,
    createdBy: string,
    approvalsRequired: number,
    key: { readonly templateId?: string; readonly modality?: string } = {},
  ): Promise<string> {
    return asTenant(orgId, async () => {
      const row = await owner.query<{ id: string }>(
        `insert into approval_policy
           (org_id, template_id, modality, approvals_required, rationale, created_by_user_id)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [
          orgId,
          key.templateId ?? null,
          key.modality ?? null,
          approvalsRequired,
          'Seeded rule.',
          createdBy,
        ],
      );

      return row.rows[0]?.id ?? '';
    });
  }

  const deps = (): { pool: pg.Pool; stepUp: TestOnlyFixedTokenStepUp } => ({ pool, stepUp });

  let lead: Actor;
  let radiologist: Actor;
  let unservedActor: Actor;
  let plainVersionId: string;
  let neuroVersionId: string;
  let unservedVersionId: string;
  let unevaluatedTemplateId: string;

  beforeAll(async () => {
    if (ownerUrl === undefined || appUrl === undefined) return;

    await runMigrations(ownerUrl);

    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    pool = createPool(appUrl, 'reporting-test-approval-policy');

    await asTenant(ORG, () =>
      owner.query('insert into org (id, name) values ($1, $2)', [ORG, 'Radiology rules']),
    );

    const served = await seedPeople(ORG, 'A');
    lead = served.lead;
    radiologist = served.radiologist;

    // Two templates: one the rules deliberately say nothing about, one they do.
    plainVersionId = await seedTemplate(ORG, 'XR Chest');
    neuroVersionId = await seedTemplate(ORG, 'CT Head');

    const neuro = await asTenant(ORG, () =>
      owner.query<{ template_id: string }>(
        'select template_id from template_version where id = $1',
        [neuroVersionId],
      ),
    );
    unevaluatedTemplateId = neuro.rows[0]?.template_id ?? '';

    // The organisation default, then a modality rule, then a rule about one exam form.
    // Resolution has to prefer them in that order — broadest last.
    await writePolicy(ORG, lead.userId, 1);
    await writePolicy(ORG, lead.userId, 2, { modality: 'CT' });
    await writePolicy(ORG, lead.userId, 3, { templateId: unevaluatedTemplateId });

    await asTenant(UNSERVED_ORG, () =>
      owner.query('insert into org (id, name) values ($1, $2)', [
        UNSERVED_ORG,
        'Radiology with no rules',
      ]),
    );

    unservedActor = (await seedPeople(UNSERVED_ORG, 'B')).lead;
    unservedVersionId = await seedTemplate(UNSERVED_ORG, 'XR Chest unscheduled');
  });

  afterAll(async () => {
    await pool?.end();
    await owner?.end();
  });

  describe('resolution', () => {
    it('falls back to the organisation default when no narrower rule matches', async () => {
      const report = await createReport(deps(), {
        actor: radiologist,
        templateVersionId: plainVersionId,
        studyInstanceUid: '1.2.840.1',
        modality: 'XR',
      });

      expect(report.approvals_required).toBe(1);
      expect(report.approvals_remaining).toBe(1);
    });

    it('prefers a modality rule to the organisation default', async () => {
      const report = await createReport(deps(), {
        actor: radiologist,
        templateVersionId: plainVersionId,
        studyInstanceUid: '1.2.840.2',
        modality: 'CT',
      });

      expect(report.approvals_required).toBe(2);
    });

    it('prefers a rule about one exam form to a rule about its whole modality', async () => {
      const report = await createReport(deps(), {
        actor: radiologist,
        templateVersionId: neuroVersionId,
        studyInstanceUid: '1.2.840.3',
        modality: 'CT',
      });

      // The specific rule is the deliberate exception to the general one. If the
      // modality rule won, writing an exception would be impossible.
      expect(report.approvals_required).toBe(3);
    });

    it('prefers the newest rule for the same key, and writes the change down', async () => {
      const report = await createReport(deps(), {
        actor: radiologist,
        templateVersionId: plainVersionId,
        studyInstanceUid: '1.2.840.4',
        modality: 'CT',
      });

      expect(report.approvals_required).toBe(2);

      // Raising the bar is an appended row, not an edit: the previous decision stays
      // readable, which is what makes the table usable as evidence.
      await writePolicy(ORG, lead.userId, 2, { modality: 'CT' });
      await writePolicy(ORG, lead.userId, 4, { modality: 'CT' });

      const raised = await createReport(deps(), {
        actor: radiologist,
        templateVersionId: plainVersionId,
        studyInstanceUid: '1.2.840.5',
        modality: 'CT',
      });

      expect(raised.approvals_required).toBe(4);

      const stored = await withTenant(pool, { orgId: ORG }, async (tx) => {
        const rows = await tx.query<{ count: string }>(
          "select count(*)::text as count from approval_policy where modality = 'CT'",
        );

        return rows.rows[0]?.count;
      });

      expect(stored).toBe('3');

      // Back to two, so the rules this suite asserts against stay as they were for any
      // later case in the file.
      await writePolicy(ORG, lead.userId, 2, { modality: 'CT' });
    });

    it('does not re-bar a report when the rule it was created under changes', async () => {
      const report = await createReport(deps(), {
        actor: radiologist,
        templateVersionId: neuroVersionId,
        studyInstanceUid: '1.2.840.6',
        modality: 'CT',
      });

      expect(report.approvals_required).toBe(3);

      // A later rule about the same template. The report was created under the old one,
      // and the trail has to keep saying so — otherwise "what was this asked to be" would
      // be answered by today's configuration rather than by the day it happened.
      await writePolicy(ORG, lead.userId, 5, { templateId: unevaluatedTemplateId });

      const reread = await getReport(deps(), radiologist, report.id);

      expect(reread.approvals_required).toBe(3);

      await writePolicy(ORG, lead.userId, 3, { templateId: unevaluatedTemplateId });
    });
  });

  describe('when no rule covers the report', () => {
    it('refuses to create it rather than assuming one signature', async () => {
      await expect(
        createReport(deps(), {
          actor: unservedActor,
          templateVersionId: unservedVersionId,
          studyInstanceUid: '1.2.840.9',
          modality: 'XR',
        }),
      ).rejects.toMatchObject({ code: 'no_approval_policy' });

      // Nothing was written. A refusal that still inserts the study would leave the next
      // attempt to reconcile a half-made report.
      const written = await withTenant(pool, { orgId: UNSERVED_ORG }, async (tx) => {
        const reports = await tx.query<{ count: string }>(
          'select count(*)::text as count from report',
        );
        const studies = await tx.query<{ count: string }>(
          'select count(*)::text as count from study',
        );

        return { reports: reports.rows[0]?.count, studies: studies.rows[0]?.count };
      });

      expect(written).toEqual({ reports: '0', studies: '0' });
    });
  });

  describe('writing a rule', () => {
    it('is closed to everyone without the approval authority', async () => {
      await expect(
        createApprovalPolicy(
          { pool },
          {
            actor: radiologist,
            approvalsRequired: 2,
            rationale: 'Radiologists should not be able to raise their own bar.',
          },
        ),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('is closed by the database too, for a row the service would never write', async () => {
      await owner.query('begin');
      await owner.query("select set_config('app.org_id', $1, true)", [ORG]);

      await expect(
        owner
          .query(
            `insert into approval_policy (org_id, approvals_required, rationale, created_by_user_id)
             values ($1, 2, 'Written past the service.', $2)`,
            [ORG, radiologist.userId],
          )
          .then(() => owner.query('commit')),
      ).rejects.toThrow(/only a clinical_lead/i);

      await owner.query('rollback').catch(() => undefined);
    });

    it('refuses a template that belongs to another tenant', async () => {
      const foreign = await withTenant(pool, { orgId: UNSERVED_ORG }, async (tx) => {
        const rows = await tx.query<{ template_id: string }>(
          'select template_id from template_version where id = $1',
          [unservedVersionId],
        );

        return rows.rows[0]?.template_id ?? '';
      });

      await expect(
        createApprovalPolicy(
          { pool },
          {
            actor: lead,
            templateId: foreign,
            approvalsRequired: 2,
            rationale: 'A rule about another hospital’s template.',
          },
        ),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    });

    it('refuses a count outside the range the column allows', async () => {
      for (const approvalsRequired of [0, 6]) {
        await expect(
          createApprovalPolicy(
            { pool },
            {
              actor: lead,
              approvalsRequired,
              rationale: 'Out of range.',
            },
          ),
        ).rejects.toMatchObject({ code: 'invalid_request' });
      }
    });

    it('refuses a rule with no reason attached', async () => {
      await expect(
        createApprovalPolicy(
          { pool },
          {
            actor: lead,
            approvalsRequired: 2,
            rationale: '   ',
          },
        ),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    });

    it('records the rule as evidence, with who set it', async () => {
      const policy = await createApprovalPolicy(
        { pool },
        {
          actor: lead,
          modality: 'MR',
          approvalsRequired: 2,
          rationale: 'Two consultants read every MR before it leaves the department.',
        },
      );

      expect(policy.created_by_user_id).toBe(lead.userId);
      expect(policy.template_id).toBeNull();
      expect(policy.modality).toBe('MR');

      const events = await withTenant(pool, { orgId: ORG }, async (tx) => {
        const rows = await tx.query<{ action: string; actor_id: string }>(
          'select action, actor_id from audit_event where subject_id = $1',
          [policy.id],
        );

        return rows.rows;
      });

      expect(events).toEqual([{ action: 'approval_policy.set', actor_id: lead.userId }]);
    });
  });

  describe('reading the rules back', () => {
    it('lists them narrowest first', async () => {
      const policies = await listApprovalPolicies({ pool }, radiologist);

      // Templates first, then modalities, then the organisation default: the order
      // resolution applies them in, so the list reads like the rule.
      const shape = policies.map((policy) => [
        policy.template_id === null ? '-' : 'template',
        policy.modality ?? '-',
      ]);

      expect(shape.at(-1)).toEqual(['-', '-']);
      expect(shape[0]?.[0]).toBe('template');
      expect(policies.length).toBeGreaterThanOrEqual(4);
    });

    it('shows another tenant nothing', async () => {
      const policies = await listApprovalPolicies({ pool }, unservedActor);

      expect(policies).toEqual([]);
    });
  });

  describe('what the database refuses on its own', () => {
    it('refuses a report that cites no rule at all', async () => {
      const ids = await withTenant(pool, { orgId: ORG }, async (tx) => {
        const study = await tx.query<{ id: string }>(
          `insert into study (org_id, study_instance_uid, modality)
           values ($1, '1.2.840.uncited', 'XR') returning id`,
          [ORG],
        );

        return { studyId: study.rows[0]?.id ?? '' };
      });

      await owner.query('begin');
      await owner.query("select set_config('app.org_id', $1, true)", [ORG]);

      await expect(
        owner
          .query(
            `insert into report (org_id, study_id, template_version_id, author_id, current_hash)
             values ($1, $2, $3, $4, 'sha256:uncited')`,
            [ORG, ids.studyId, plainVersionId, radiologist.userId],
          )
          .then(() => owner.query('commit')),
      ).rejects.toThrow(/without an approval policy/i);

      await owner.query('rollback').catch(() => undefined);
    });

    it('refuses a report whose number disagrees with the rule it cites', async () => {
      const policyId = await writePolicy(ORG, lead.userId, 1);

      const study = await withTenant(pool, { orgId: ORG }, async (tx) => {
        const rows = await tx.query<{ id: string }>(
          `insert into study (org_id, study_instance_uid, modality)
           values ($1, '1.2.840.disagreeing', 'XR') returning id`,
          [ORG],
        );

        return rows.rows[0]?.id ?? '';
      });

      await owner.query('begin');
      await owner.query("select set_config('app.org_id', $1, true)", [ORG]);

      await expect(
        owner
          .query(
            `insert into report (org_id, study_id, template_version_id, author_id, current_hash,
                                 approvals_required, approval_policy_id)
             values ($1, $2, $3, $4, 'sha256:disagreeing', 4, $5)`,
            [ORG, study, plainVersionId, radiologist.userId, policyId],
          )
          .then(() => owner.query('commit')),
      ).rejects.toThrow(/does not say so/i);

      await owner.query('rollback').catch(() => undefined);
    });
  });
});
