import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run from the root and resolve workspace packages to source, so
    // `pnpm test` works on a fresh clone without a build step first. The built
    // output is what turbo type-checks and what ships.
    alias: {
      '@reporting/tokens': fromRoot('./packages/tokens/src/index.ts'),
      '@reporting/template-schema': fromRoot('./packages/template-schema/src/index.ts'),
      '@reporting/validation': fromRoot('./packages/validation/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
  },
});
