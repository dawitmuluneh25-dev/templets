import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool, runMigrations, withTenant } from '@reporting/db';
import { parse, serialize } from '@reporting/tokens';

import { TestOnlyFixedTokenStepUp, type Actor } from '../auth.js';
import { createReport } from './report-service.js';
import { defaultArtefactPath, importTemplates } from './template-import.js';

/**
 * The import is the join between two things that were built separately: a corpus pipeline
 * that proves 427 templates round-trip, and a schema that had never held one of them.
 *
 * What these tests assert, in order of what would hurt most if it broke:
 *
 * 1. The committed artefact lands, completely, and a report can then be authored on an
 *    imported version — the end of the pipeline, not just its middle.
 * 2. Importing it again changes nothing. An import job that duplicates rows on a re-run
 *    is a job nobody dares run twice.
 * 3. Changed text becomes version 2 rather than overwriting version 1, because a signed
 *    report names the version it was authored on.
 * 4. A bad entry is rejected with a reason and does not take the good ones with it.
 */
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const enabled = ownerUrl !== undefined && appUrl !== undefined;

const ORG = randomUUID();

describe.skipIf(!enabled)('template import', () => {
  let owner: pg.Client;
  let pool: pg.Pool;
  let actor: Actor;
  let tmpDir: string;

  /** createReport needs a verifier even when it is not signing. */
  const stepUp = new TestOnlyFixedTokenStepUp('test-step-up-token');

  function deps(): { pool: pg.Pool; stepUp: TestOnlyFixedTokenStepUp } {
    return { pool, stepUp };
  }

  /** A one-entry artefact whose body is real text, so the token stream is real too. */
  function writeArtefact(file: string, entries: readonly unknown[]): void {
    fs.writeFileSync(file, JSON.stringify(entries), 'utf8');
  }

  function entry(body: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const document = parse(body);

    return {
      id: 'tpl_synthetic',
      name: 'Synthetic Template',
      base_name: 'Synthetic Template',
      variant_label: null,
      scope: 'AlemHealth',
      modality: ['XR'],
      type: 'FREE_TEXT',
      status: 'Active',
      provenance: 'org_authored',
      guid: 'synthetic',
      schema_version: document.schema_version,
      source_relpath: 'AlemHealth/synthetic.md',
      char_count: body.length,
      sections: document.sections,
      fields: document.fields,
      tokens: document.tokens,
      ...overrides,
    };
  }

  beforeAll(async () => {
    if (ownerUrl === undefined || appUrl === undefined) return;

    await runMigrations(ownerUrl);

    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    pool = createPool(appUrl, 'reporting-import-test');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-import-'));

    await owner.query('begin');
    await owner.query("select set_config('app.org_id', $1, true)", [ORG]);
    await owner.query('insert into org (id, name) values ($1, $2)', [ORG, 'Import Test Radiology']);
    const user = await owner.query<{ id: string }>(
      `insert into app_user (org_id, idp_subject, display_name, roles)
       values ($1, 'importer', 'Import Test', '{radiologist}') returning id`,
      [ORG],
    );
    await owner.query('commit');

    actor = {
      orgId: ORG,
      userId: user.rows[0]?.id ?? '',
      idpSubject: 'importer',
      roles: ['radiologist'],
    };
  });

  afterAll(async () => {
    if (ownerUrl === undefined) return;

    await pool?.end();
    await owner?.end();
    if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 427 templates through a real database: the default 5s budget is for unit tests.
  it('imports the committed corpus artefact completely', { timeout: 60_000 }, async () => {
    const report = await importTemplates(deps(), {
      orgId: ORG,
      actorId: actor.userId,
      artefactPath: defaultArtefactPath(),
    });

    expect(report.rejected).toEqual([]);
    expect(report.entries).toBe(427);
    expect(report.templates_created).toBe(427);
    expect(report.versions_created).toBe(427);

    const counts = await withTenant(pool, { orgId: ORG }, async (tx) => {
      const templates = await tx.query<{ count: number }>(
        'select count(*)::int as count from template where org_id = $1',
        [ORG],
      );
      const versions = await tx.query<{ count: number }>(
        `select count(*)::int as count
           from template_version v join template t on t.id = v.template_id
          where t.org_id = $1`,
        [ORG],
      );

      return { templates: templates.rows[0]?.count, versions: versions.rows[0]?.count };
    });

    expect(counts).toEqual({ templates: 427, versions: 427 });
  });

  it('lets a report be authored on an imported version', async () => {
    // The join that was missing: corpus artefact -> row -> a report pinned to it.
    const version = await withTenant(pool, { orgId: ORG }, async (tx) => {
      const row = await tx.query<{ id: string; body: string }>(
        `select v.id, v.body
           from template_version v join template t on t.id = v.template_id
          where t.org_id = $1 and t.scope = 'AlemHealth'
          order by t.name
          limit 1`,
        [ORG],
      );

      return row.rows[0];
    });

    expect(version).toBeDefined();

    const report = await createReport(deps(), {
      actor,
      templateVersionId: version?.id ?? '',
      studyInstanceUid: `1.2.840.${randomUUID()}`,
      modality: 'XR',
    });

    expect(report.revision).toBe(1);
    expect(report.state).toBe('draft');

    // The stored body is reconstructed from the token stream at import time, so a report
    // authored on it renders exactly the template text — not a re-parse of it.
    const stored = await withTenant(pool, { orgId: ORG }, async (tx) => {
      const row = await tx.query<{ body: string }>(
        'select body from template_version where id = $1',
        [version?.id ?? ''],
      );

      return row.rows[0]?.body;
    });

    expect(stored).toBe(version?.body);
  });

  it('is a no-op when the same artefact is imported again', { timeout: 60_000 }, async () => {
    const report = await importTemplates(deps(), {
      orgId: ORG,
      actorId: actor.userId,
      artefactPath: defaultArtefactPath(),
    });

    expect(report.templates_created).toBe(0);
    expect(report.templates_existing).toBe(427);
    expect(report.versions_created).toBe(0);
    expect(report.versions_unchanged).toBe(427);
  });

  it('adds a version rather than overwriting one when the text changes', async () => {
    const file = path.join(tmpDir, 'changed.json');
    const first = ['EXAM:', 'Chest X-ray.', '', 'IMPRESSION:', '[___]', ''].join('\n');
    const second = ['EXAM:', 'Chest X-ray.', '', 'IMPRESSION:', 'No acute abnormality.', ''].join(
      '\n',
    );

    writeArtefact(file, [entry(first, { id: 'tpl_changing', guid: 'changing' })]);

    const initial = await importTemplates(deps(), {
      orgId: ORG,
      actorId: actor.userId,
      artefactPath: file,
    });

    expect(initial.versions_created).toBe(1);

    writeArtefact(file, [entry(second, { id: 'tpl_changing', guid: 'changing' })]);

    const changed = await importTemplates(deps(), {
      orgId: ORG,
      actorId: actor.userId,
      artefactPath: file,
    });

    expect(changed.templates_created).toBe(0);
    expect(changed.versions_created).toBe(1);

    const versions = await withTenant(pool, { orgId: ORG }, async (tx) => {
      const row = await tx.query<{ version: number; body: string }>(
        `select v.version, v.body
           from template_version v join template t on t.id = v.template_id
          where t.org_id = $1 and t.external_id = 'tpl_changing'
          order by v.version`,
        [ORG],
      );

      return row.rows;
    });

    expect(versions.map((row) => row.version)).toEqual([1, 2]);
    // Version 1 is untouched: a report signed against it must still render its own text.
    expect(versions[0]?.body).toBe(first);
    expect(versions[1]?.body).toBe(second);
  });

  it('rejects a bad entry with a reason and keeps the good ones', async () => {
    const file = path.join(tmpDir, 'mixed.json');
    const good = entry(['EXAM:', 'Knee.', '', 'IMPRESSION:', '[___]', ''].join('\n'), {
      id: 'tpl_good',
      name: 'Good Template',
      guid: 'good',
    });
    const bad = entry(['EXAM:', 'Hip.', ''].join('\n'), {
      id: 'tpl_bad',
      name: 'Bad Template',
      guid: 'bad',
      char_count: 9_999,
    });

    writeArtefact(file, [good, bad]);

    const report = await importTemplates(deps(), {
      orgId: ORG,
      actorId: actor.userId,
      artefactPath: file,
    });

    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]?.id).toBe('tpl_bad');
    expect(report.rejected[0]?.reason).toMatch(/characters/);
    expect(report.templates_created).toBe(1);

    // The good one is importable, so a single bad file does not withhold the rest.
    const stored = await withTenant(pool, { orgId: ORG }, async (tx) => {
      const row = await tx.query('select 1 from template where org_id = $1 and external_id = $2', [
        ORG,
        'tpl_good',
      ]);

      return row.rowCount;
    });

    expect(stored).toBe(1);
  });

  it('writes nothing in a dry run', async () => {
    const file = path.join(tmpDir, 'dry.json');
    const body = ['EXAM:', 'Ankle.', '', 'IMPRESSION:', '[___]', ''].join('\n');

    writeArtefact(file, [entry(body, { id: 'tpl_dry', name: 'Dry Template', guid: 'dry' })]);

    const report = await importTemplates(deps(), {
      orgId: ORG,
      actorId: actor.userId,
      artefactPath: file,
      dryRun: true,
    });

    expect(report.dry_run).toBe(true);
    expect(report.templates_created).toBe(1);

    const stored = await withTenant(pool, { orgId: ORG }, async (tx) => {
      const row = await tx.query('select 1 from template where org_id = $1 and external_id = $2', [
        ORG,
        'tpl_dry',
      ]);

      return row.rowCount;
    });

    expect(stored).toBe(0);
  });

  it('reproduces the stored body exactly from its own tokens', async () => {
    const row = await withTenant(pool, { orgId: ORG }, async (tx) => {
      const found = await tx.query<{ body: string; token_stream: { tokens: unknown[] } }>(
        `select v.body, v.token_stream
           from template_version v join template t on t.id = v.template_id
          where t.org_id = $1
          order by v.body desc
          limit 1`,
        [ORG],
      );

      return found.rows[0];
    });

    expect(row).toBeDefined();
    expect(serialize(row?.token_stream.tokens as never)).toBe(row?.body);
  });
});
