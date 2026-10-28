import { runMigrations } from './migrate.js';

const connectionString = process.env.DATABASE_URL;

if (connectionString === undefined || connectionString === '') {
  console.error('DATABASE_URL is not set. See .env.example.');
  process.exit(1);
}

const result = await runMigrations(connectionString);

console.log(
  result.applied.length === 0
    ? `database is up to date (${result.alreadyApplied} migrations applied)`
    : `applied: ${result.applied.join(', ')}`,
);
