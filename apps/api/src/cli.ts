import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderOpenApi } from './openapi.js';
import { ROUTES } from './routes.js';

/**
 * Writes the committed OpenAPI artefact.
 *
 * The file is a review artefact — an API change should appear in a diff as a
 * change to the contract, not only as a change to a handler. CI regenerates it and
 * fails on any difference, so it cannot go stale.
 */
const OUTPUT = fileURLToPath(new URL('../openapi.json', import.meta.url));

const command = process.argv[2];

if (command !== 'openapi') {
  console.error('usage: node dist/cli.js openapi');
  process.exitCode = 1;
} else {
  fs.writeFileSync(OUTPUT, renderOpenApi(ROUTES), 'utf8');
  console.log(`wrote ${OUTPUT}`);
}
