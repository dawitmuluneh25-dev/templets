import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool, runMigrations, withTenant } from '@reporting/db';

import { TestOnlyFixedTokenStepUp, type Actor } from '../auth.js';
import { createReport, signReport } from '../domain/report-service.js';
import { deliverReport, deliveryIdempotencyKey } from './delivery-service.js';
import { FhirReportSink, toFhirDiagnosticReport, type HttpTransport } from './fhir.js';
import {
  IntegrationNotConfiguredError,
  type DeliveryReceipt,
  type FinalReport,
  type ReportSink,
} from './ports.js';
import { configFromEnv, createIntegration } from './registry.js';

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const enabled = ownerUrl !== undefined && appUrl !== undefined;

const ORG = randomUUID();
const STEP_UP_TOKEN = 'test-step-up-token';

const REPORT: FinalReport = {
  reportId: randomUUID(),
  contentHash: 'sha256:abc123',
  text: 'IMPRESSION:\nNo acute abnormality.',
  signedAt: '2026-10-29T10:00:00.000Z',
  author: { identifier: 'idp|radiologist', displayName: 'Dr Test' },
  studyInstanceUid: '1.2.840.113619.2.55.3',
};

/** Records how many times it was asked, which is the only way to test idempotency. */
class RecordingSink implements ReportSink {
  readonly id = 'recording';
  calls = 0;
  failWith: string | null = null;

  async deliver(): Promise<DeliveryReceipt> {
    this.calls += 1;

    if (this.failWith !== null) throw new Error(this.failWith);

    return { externalId: `ehr-${this.calls}` };
  }
}

describe('FHIR mapping', () => {
  it('sends a final report carrying the hash it was signed against', () => {
    const resource = toFhirDiagnosticReport(REPORT);

    expect(resource.resourceType).toBe('DiagnosticReport');
    expect(resource.status).toBe('final');
    expect(resource.conclusion).toBe(REPORT.text);
    expect(resource.issued).toBe(REPORT.signedAt);
    expect(resource.extension).toEqual([
      { url: 'urn:alemhealth:reporting:content-hash', valueString: REPORT.contentHash },
      {
        url: 'urn:alemhealth:reporting:study-instance-uid',
        valueString: REPORT.studyInstanceUid,
      },
    ]);
  });

  it('posts to the configured endpoint and returns the far end id', async () => {
    const requests: { url: string; body?: string }[] = [];

    const transport: HttpTransport = async (request) => {
      requests.push({
        url: request.url,
        ...(request.body === undefined ? {} : { body: request.body }),
      });

      return { status: 201, body: JSON.stringify({ id: 'dr-42' }) };
    };

    const sink = new FhirReportSink({ baseUrl: 'https://ehr.test/fhir' }, transport);
    const receipt = await sink.deliver(REPORT);

    expect(receipt.externalId).toBe('dr-42');
    expect(requests[0]?.url).toBe('https://ehr.test/fhir/DiagnosticReport');
    expect(JSON.parse(requests[0]?.body ?? '{}')).toMatchObject({ status: 'final' });
  });

  it('raises the far end’s own explanation rather than a bare status', async () => {
    const sink = new FhirReportSink({ baseUrl: 'https://ehr.test/fhir' }, async () => ({
      status: 422,
      body: 'Patient reference could not be resolved',
    }));

    await expect(sink.deliver(REPORT)).rejects.toThrow(/422.*Patient reference/);
  });
});

describe('adapter registry', () => {
  it('fails closed when a capability is not configured', async () => {
    const integration = createIntegration({}, async () => ({ status: 200, body: '{}' }));

    await expect(integration.reportSink.deliver(REPORT)).rejects.toBeInstanceOf(
      IntegrationNotConfiguredError,
    );

    // The message names what is missing, because the person reading it is an operator.
    await expect(integration.reportSink.deliver(REPORT)).rejects.toThrow(/report delivery/);
  });

  it('builds nothing it was not told to, and everything it was', async () => {
    const integration = createIntegration(
      { reportSink: { adapter: 'fhir-r4', baseUrl: 'https://ehr.test/fhir' } },
      async () => ({ status: 201, body: JSON.stringify({ id: 'dr-1' }) }),
    );

    expect(integration.reportSink.id).toBe('fhir-r4');
    // PACS was not configured, so asking it is an operator error, not an empty answer.
    await expect(integration.pacs.fetchStudy('1.2.3')).rejects.toThrow(
      IntegrationNotConfiguredError,
    );
  });

  it('refuses an adapter name it does not have, at startup', () => {
    expect(() =>
      configFromEnv({
        INTEGRATION_EHR_BASE_URL: 'https://ehr.test/fhir',
        INTEGRATION_EHR_ADAPTER: 'epic-proprietary',
      }),
    ).toThrow(/Unknown adapter/);
  });

  it('treats an unset endpoint as unconfigured rather than as an error', () => {
    expect(configFromEnv({})).toEqual({});
  });
});

describe('idempotency key', () => {
  it('is the same for the same bytes and different for another target', () => {
    const key = deliveryIdempotencyKey('report-1', 'sha256:a', 'ehr');

    expect(key).toBe(deliveryIdempotencyKey('report-1', 'sha256:a', 'ehr'));
    expect(key).not.toBe(deliveryIdempotencyKey('report-1', 'sha256:a', 'pacs'));
    expect(key).not.toBe(deliveryIdempotencyKey('report-1', 'sha256:b', 'ehr'));
    // Two reports that read identically are still two reports.
    expect(key).not.toBe(deliveryIdempotencyKey('report-2', 'sha256:a', 'ehr'));
  });
});

describe.skipIf(!enabled)('delivery state machine', () => {
  let owner: pg.Client;
  let pool: pg.Pool;
  let actor: Actor;
  let versionId: string;

  const stepUp = new TestOnlyFixedTokenStepUp(STEP_UP_TOKEN);

  /** A signed report, through the real service, so state and evidence are consistent. */
  async function signedReport(): Promise<string> {
    const report = await createReport(
      { pool, stepUp },
      {
        actor,
        templateVersionId: versionId,
        studyInstanceUid: `1.2.840.${randomUUID()}`,
        modality: 'XR',
      },
    );

    const signed = await signReport(
      { pool, stepUp },
      {
        actor,
        reportId: report.id,
        ifMatch: report.current_hash,
        stepUpAssertion: STEP_UP_TOKEN,
      },
    );

    expect(signed.state).toBe('signed');

    return signed.id;
  }

  beforeAll(async () => {
    if (ownerUrl === undefined || appUrl === undefined) return;

    await runMigrations(ownerUrl);

    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    pool = createPool(appUrl, 'reporting-integration-test');

    await owner.query('begin');
    await owner.query("select set_config('app.org_id', $1, true)", [ORG]);
    await owner.query('insert into org (id, name) values ($1, $2)', [
      ORG,
      'Delivery Test Radiology',
    ]);

    const user = await owner.query<{ id: string }>(
      `insert into app_user (org_id, idp_subject, display_name, roles)
       values ($1, 'deliverer', 'Dr Deliverer', '{radiologist}') returning id`,
      [ORG],
    );

    const template = await owner.query<{ id: string }>(
      `insert into template
         (org_id, name, base_name, scope, modality, type, provenance, licence_status)
       values ($1, 'Chest X-ray', 'Chest X-ray', 'AlemHealth', 'XR', 'FREE_TEXT',
               '{"class":"org_authored"}'::jsonb, 'user_provided')
       returning id`,
      [ORG],
    );

    const document = {
      schema_version: 1,
      tokens: [{ kind: 'text', value: 'IMPRESSION:\nNo acute abnormality.' }],
    };

    const version = await owner.query<{ id: string }>(
      `insert into template_version
         (org_id, template_id, version, body, token_stream, fields, content_hash)
       values ($1, $2, 1, $3, $4, '[]'::jsonb, 'sha256:template') returning id`,
      [
        ORG,
        template.rows[0]?.id ?? '',
        'IMPRESSION:\nNo acute abnormality.',
        JSON.stringify(document),
      ],
    );

    await owner.query('commit');

    versionId = version.rows[0]?.id ?? '';
    actor = {
      orgId: ORG,
      userId: user.rows[0]?.id ?? '',
      idpSubject: 'deliverer',
      roles: ['radiologist'],
    };
  });

  afterAll(async () => {
    if (ownerUrl === undefined) return;

    await pool?.end();
    await owner?.end();
  });

  it('delivers a signed report once, and records what the far end called it', async () => {
    const sink = new RecordingSink();
    const reportId = await signedReport();

    const outcome = await deliverReport({ pool, reportSink: sink }, { orgId: ORG, reportId });

    expect(outcome).toMatchObject({ status: 'delivered', duplicate: false, externalId: 'ehr-1' });
    expect(sink.calls).toBe(1);

    const row = await withTenant(pool, { orgId: ORG }, async (tx) => {
      const found = await tx.query<{ status: string; attempts: number; external_id: string }>(
        'select status, attempts, external_id from delivery where id = $1',
        [outcome.deliveryId],
      );

      return found.rows[0];
    });

    expect(row).toMatchObject({ status: 'delivered', attempts: 1, external_id: 'ehr-1' });
  });

  it('re-delivering the same report does not deliver it twice', async () => {
    const sink = new RecordingSink();
    const reportId = await signedReport();

    const first = await deliverReport({ pool, reportSink: sink }, { orgId: ORG, reportId });
    const second = await deliverReport({ pool, reportSink: sink }, { orgId: ORG, reportId });

    expect(second).toMatchObject({ status: 'delivered', duplicate: true });
    expect(second.deliveryId).toBe(first.deliveryId);
    // The property that makes a retry after a timeout safe: the far end sees one report.
    expect(sink.calls).toBe(1);
  });

  it('records a failure, then succeeds on a later attempt', async () => {
    const sink = new RecordingSink();
    sink.failWith = 'connection reset by peer';

    const reportId = await signedReport();

    const failed = await deliverReport({ pool, reportSink: sink }, { orgId: ORG, reportId });

    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
    expect(failed).toHaveProperty('error', expect.stringMatching(/connection reset/));

    const recorded = await withTenant(pool, { orgId: ORG }, async (tx) => {
      const found = await tx.query<{ status: string; last_error: string }>(
        'select status, last_error from delivery where id = $1',
        [failed.deliveryId],
      );

      return found.rows[0];
    });

    expect(recorded).toMatchObject({ status: 'failed', last_error: 'connection reset by peer' });

    sink.failWith = null;

    const retried = await deliverReport({ pool, reportSink: sink }, { orgId: ORG, reportId });

    expect(retried).toMatchObject({ status: 'delivered', duplicate: false });
    // Same row, second attempt: a failed delivery is a retry, not a new deliverable.
    expect(retried.deliveryId).toBe(failed.deliveryId);
    expect(sink.calls).toBe(2);
  });

  it('refuses to deliver a report nobody has signed', async () => {
    const sink = new RecordingSink();
    const draft = await createReport(
      { pool, stepUp },
      {
        actor,
        templateVersionId: versionId,
        studyInstanceUid: `1.2.840.${randomUUID()}`,
        modality: 'XR',
      },
    );

    await expect(
      deliverReport({ pool, reportSink: sink }, { orgId: ORG, reportId: draft.id }),
    ).rejects.toMatchObject({ code: 'report_not_signed' });

    expect(sink.calls).toBe(0);
  });
});
