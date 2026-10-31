import { createPool } from '@reporting/db';

import { DenyAllAuthenticator, HeaderAuthenticator, UnconfiguredStepUp } from './auth.js';
import { buildServer } from './server.js';

/**
 * Process entry point.
 *
 * Two fail-closed choices, both about not shipping a demo that looks finished:
 *
 * - No identity provider configured → every request is 401, rather than a
 *   development header being silently accepted.
 * - No step-up verifier configured → signing returns 503 rather than succeeding
 *   unchecked. A signature produced without a second factor is worse than a
 *   missing feature, because it is indistinguishable from a real one.
 */
const databaseUrl = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl === '') {
  console.error(
    'APP_DATABASE_URL is required. The API connects as the runtime role, never the schema owner.',
  );
  process.exit(1);
}

const isProduction = process.env.NODE_ENV === 'production';
const allowHeaderAuth = process.env.API_ALLOW_HEADER_AUTH === 'true';
const orgId = process.env.ORG_ID ?? '';

if (isProduction && allowHeaderAuth) {
  console.error(
    'API_ALLOW_HEADER_AUTH cannot be enabled with NODE_ENV=production: a header is a claim, not a credential.',
  );
  process.exit(1);
}

const pool = createPool(databaseUrl, 'reporting-api');

const authenticator =
  allowHeaderAuth && orgId !== ''
    ? new HeaderAuthenticator(pool, orgId)
    : new DenyAllAuthenticator();

const app = buildServer({
  pool,
  authenticator,
  stepUp: new UnconfiguredStepUp(),
  logger: true,
});

const port = Number(process.env.PORT ?? '3000');
const host = process.env.HOST ?? '127.0.0.1';

await app.listen({ port, host });

app.log.warn(`auth: ${authenticator.description}`);
app.log.warn('step-up: none configured — POST /v1/reports/:id/sign returns 503 until E9 is closed');

async function shutdown(signal: string): Promise<void> {
  app.log.warn(`received ${signal}, closing`);
  await app.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
