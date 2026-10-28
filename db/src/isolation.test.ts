import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from './migrate.js';

/**
 * The tenancy test ADR-0003 asks for: two organisations, one schema, and not one
 * row crossing between them — checked through the *application* role, which owns
 * nothing and cannot bypass RLS.
 *
 * Runs against a real PostgreSQL. It is skipped when TEST_DATABASE_URL is unset
 * rather than mocked: a policy tested against a mock proves the mock.
 */
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const enabled = ownerUrl !== undefined && appUrl !== undefined;

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

interface Seed {
  readonly reportId: string;
  readonly userId: string;
  readonly versionId: string;
}

describe.skipIf(!enabled)('row-level security', () => {
  let owner: pg.Client;
  let app: pg.Client;
  let a: Seed;
  let b: Seed;

  /** Everything a tenant needs to hold one report. Runs as the owner, under RLS. */
  async function seed(orgId: string, label: string): Promise<Seed> {
    await owner.query('begin');
    await owner.query("select set_config('app.org_id', $1, true)", [orgId]);

    await owner.query('insert into org (id, name) values ($1, $2)', [orgId, `Radiology ${label}`]);

    const user = await owner.query<{ id: string }>(
      'insert into app_user (org_id, idp_subject, display_name, roles) values ($1, $2, $3, $4) returning id',
      [orgId, `subject-${label}`, `Dr ${label}`, ['radiologist']],
    );
    const userId = user.rows[0]?.id ?? '';

    const template = await owner.query<{ id: string }>(
      `insert into template (org_id, name, scope, modality, type, provenance)
       values ($1, $2, 'AlemHealth', 'XR', 'FREE_TEXT', $3) returning id`,
      [orgId, `XR Chest ${label}`, JSON.stringify({ class: 'unknown' })],
    );

    const version = await owner.query<{ id: string }>(
      `insert into template_version (template_id, version, body, token_stream, content_hash)
       values ($1, 1, $2, $3, $4) returning id`,
      [template.rows[0]?.id ?? '', 'FINDINGS:\nNormal.', JSON.stringify([]), `sha256:${label}`],
    );
    const versionId = version.rows[0]?.id ?? '';

    const study = await owner.query<{ id: string }>(
      `insert into study (org_id, study_instance_uid, modality)
       values ($1, $2, 'XR') returning id`,
      [orgId, `1.2.840.${label}`],
    );

    const report = await owner.query<{ id: string }>(
      `insert into report (org_id, study_id, template_version_id, author_id, current_hash)
       values ($1, $2, $3, $4, $5) returning id`,
      [orgId, study.rows[0]?.id ?? '', versionId, userId, `sha256:report-${label}`],
    );

    await owner.query('commit');

    return { reportId: report.rows[0]?.id ?? '', userId, versionId };
  }

  /** Sets the tenant for this session, the way the API does per transaction. */
  async function asOrg(client: pg.Client, orgId: string | null): Promise<void> {
    await client.query("select set_config('app.org_id', $1, false)", [orgId ?? '']);
  }

  beforeAll(async () => {
    if (ownerUrl === undefined || appUrl === undefined) return;

    await runMigrations(ownerUrl);

    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    await owner.query(`
      truncate audit_event, signature, report_revision, report, study,
        template_version, template, app_user, org restart identity cascade
    `);

    a = await seed(ORG_A, 'A');
    b = await seed(ORG_B, 'B');

    app = new pg.Client({ connectionString: appUrl });
    await app.connect();
  }, 60_000);

  afterAll(async () => {
    await app?.end();
    await owner?.end();
  });

  it('shows each tenant only its own rows', async () => {
    await asOrg(app, ORG_A);
    const own = await app.query<{ id: string; org_id: string }>('select id, org_id from report');

    expect(own.rowCount).toBe(1);
    expect(own.rows[0]?.id).toBe(a.reportId);
    expect(own.rows[0]?.org_id).toBe(ORG_A);
  });

  it('returns nothing for another tenant even when asked explicitly', async () => {
    await asOrg(app, ORG_A);
    const crossed = await app.query('select id from report where org_id = $1', [ORG_B]);

    expect(crossed.rowCount).toBe(0);
  });

  it('refuses to insert a row belonging to another tenant', async () => {
    await asOrg(app, ORG_A);

    await expect(
      app.query(
        `insert into report (org_id, study_id, template_version_id, author_id, current_hash)
         values ($1, (select study_id from report where id = $2), $3, $4, 'sha256:x')`,
        [ORG_B, a.reportId, a.versionId, a.userId],
      ),
    ).rejects.toThrow(/row-level security|permission denied/i);
  });

  it('cannot update or delete another tenant’s rows', async () => {
    await asOrg(app, ORG_B);

    const update = await app.query('update report set urgent = true where id = $1', [a.reportId]);
    expect(update.rowCount).toBe(0);

    // Deletion is refused outright: a signed report is evidence.
    await expect(app.query('delete from report where id = $1', [a.reportId])).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('raises rather than returning nothing when the tenant is not set', async () => {
    await asOrg(app, null);

    await expect(app.query('select count(*) from report')).rejects.toThrow(
      /unrecognized configuration parameter|invalid input syntax/i,
    );
  });

  it('refuses to mutate an applied template version, even as the owner', async () => {
    await owner.query('begin');
    await owner.query("select set_config('app.org_id', $1, true)", [ORG_A]);

    await expect(
      owner.query('update template_version set version = 2 where id = $1', [a.versionId]),
    ).rejects.toThrow(/append-only/i);

    await owner.query('rollback');
  });

  it('keeps the template snapshot the report was authored against', async () => {
    await asOrg(app, ORG_A);

    const pinned = await app.query<{ template_version_id: string }>(
      'select template_version_id from report where id = $1',
      [a.reportId],
    );

    expect(pinned.rows[0]?.template_version_id).toBe(a.versionId);
    expect(b.versionId).not.toBe(a.versionId);
  });
});
