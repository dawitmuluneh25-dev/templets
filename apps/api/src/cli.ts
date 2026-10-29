import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createPool } from '@reporting/db';

import { importTemplates } from './domain/template-import.js';
import { renderOpenApi } from './openapi.js';
import { ROUTES } from './routes.js';

/**
 * The operator-facing commands. Two so far, both of which produce something a human or CI
 * reviews rather than something the running service needs.
 *
 * Exit codes are part of the interface, because CI reads them:
 *   0 — did what it said
 *   1 — refused to run, or a write failed (nothing was written)
 *   2 — ran, but rejected some input (see the report); this is not success
 */
const USAGE = `usage:
  node dist/cli.js openapi
  node dist/cli.js import-templates --org <uuid> [--actor <uuid>] [--artefact <path>] [--dry-run]`;

/** Writes the committed OpenAPI artefact. Regenerated in CI and diffed there. */
const OPENAPI_OUTPUT = fileURLToPath(new URL('../openapi.json', import.meta.url));

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;

  const value = args[index + 1];

  return value === undefined || value.startsWith('--') ? undefined : value;
}

function printImportReport(report: Awaited<ReturnType<typeof importTemplates>>): void {
  console.log('--- template import ---');
  console.log(`source             ${report.source}`);
  console.log(`mode               ${report.dry_run ? 'dry run (nothing written)' : 'applied'}`);
  console.log(`entries            ${report.entries}`);
  console.log(`templates created  ${report.templates_created}`);
  console.log(`templates existing ${report.templates_existing}`);
  console.log(`versions created   ${report.versions_created}`);
  console.log(`versions unchanged ${report.versions_unchanged}`);
  console.log(`by provenance      ${JSON.stringify(report.by_provenance)}`);

  if (report.rejected.length > 0) {
    console.log(`rejected           ${report.rejected.length}`);
    for (const record of report.rejected.slice(0, 20)) {
      console.log(`  ${record.id} | ${record.name} | ${record.reason}`);
    }
    if (report.rejected.length > 20) {
      console.log(`  … and ${report.rejected.length - 20} more`);
    }
  }
}

async function main(args: readonly string[]): Promise<number> {
  const command = args[0];

  if (command === 'openapi') {
    fs.writeFileSync(OPENAPI_OUTPUT, renderOpenApi(ROUTES), 'utf8');
    console.log(`wrote ${OPENAPI_OUTPUT}`);

    return 0;
  }

  if (command === 'import-templates') {
    const orgId = flag(args, 'org');

    if (orgId === undefined) {
      console.error('import-templates needs --org <uuid>: an import belongs to a tenant.');
      console.error(USAGE);

      return 1;
    }

    const connectionString = process.env.DATABASE_URL;

    if (connectionString === undefined) {
      console.error('DATABASE_URL is not set.');

      return 1;
    }

    const pool = createPool(connectionString, 'reporting-import');

    const actorId = flag(args, 'actor');
    const artefactPath = flag(args, 'artefact');

    try {
      const report = await importTemplates(
        { pool },
        {
          orgId,
          ...(actorId === undefined ? {} : { actorId }),
          ...(artefactPath === undefined ? {} : { artefactPath }),
          ...(args.includes('--dry-run') ? { dryRun: true } : {}),
        },
      );

      printImportReport(report);

      // Rejected entries are a real outcome, not a warning: an import that skipped
      // 12 templates must not read as an import that did its job.
      return report.rejected.length > 0 ? 2 : 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));

      return 1;
    } finally {
      await pool.end();
    }
  }

  console.error(USAGE);

  return 1;
}

process.exitCode = await main(process.argv.slice(2));
