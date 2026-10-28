/**
 * Migration runner.
 *
 * Two rules, both about trust:
 *
 * 1. A migration is applied at most once, and only if the file is unchanged
 *    since it was applied. Editing history to make a database "match" is how a
 *    schema stops being evidence — the same argument as ADRs being append-only.
 * 2. Each file owns its transaction (every migration starts with `begin` and
 *    ends with `commit`), so a failure part-way leaves nothing behind and no
 *    row in `schema_migration`.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

/** Resolves to `db/migrations/` from both `src/` and `dist/`. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: number;
}

function checksum(sql: string): string {
  return `sha256:${createHash('sha256').update(sql, 'utf8').digest('hex')}`;
}

export async function runMigrations(connectionString: string): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      create table if not exists schema_migration (
        version     text primary key,
        checksum    text not null,
        applied_at  timestamptz not null default now()
      )
    `);

    const appliedRows = await client.query<{ version: string; checksum: string }>(
      'select version, checksum from schema_migration',
    );
    const applied = new Map(appliedRows.rows.map((row) => [row.version, row.checksum]));

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort();

    const newlyApplied: string[] = [];

    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const hash = checksum(sql);
      const previous = applied.get(file);

      if (previous !== undefined) {
        if (previous !== hash) {
          throw new Error(
            `Migration ${file} changed after it was applied. ` +
              'Write a new migration that supersedes it; do not edit history.',
          );
        }
        continue;
      }

      await client.query(sql);
      await client.query('insert into schema_migration (version, checksum) values ($1, $2)', [
        file,
        hash,
      ]);
      newlyApplied.push(file);
    }

    return { applied: newlyApplied, alreadyApplied: applied.size };
  } finally {
    await client.end();
  }
}
