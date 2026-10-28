import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const fromRoot = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/**
 * Reads `.env.local` for local database URLs. Deliberately tiny and dependency
 * free: tests that need a real PostgreSQL skip themselves when these are absent,
 * and CI supplies them from a service container instead.
 */
function readLocalEnv(): Record<string, string> {
  const file = path.resolve('.env.local');
  if (!fs.existsSync(file)) return {};

  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined) env[match[1]] = (match[2] ?? '').trim();
  }
  return env;
}

export default defineConfig({
  resolve: {
    // Tests resolve workspace packages to source, so `pnpm test` works on a
    // fresh clone without a build step. Built output is what CI type-checks.
    alias: {
      '@reporting/tokens': fromRoot('./packages/tokens/src/index.ts'),
      '@reporting/template-schema': fromRoot('./packages/template-schema/src/index.ts'),
      '@reporting/validation': fromRoot('./packages/validation/src/index.ts'),
      '@reporting/db': fromRoot('./db/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'db/src/**/*.test.ts'],
    environment: 'node',
    env: readLocalEnv(),
  },
});
