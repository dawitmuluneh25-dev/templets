import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildOpenApiDoc, renderOpenApi } from './openapi.js';
import { ROUTES } from './routes.js';

const COMMITTED = fileURLToPath(new URL('../openapi.json', import.meta.url));

interface Operation {
  readonly operationId: string;
  readonly parameters?: readonly { name: string; in: string }[];
  readonly responses: Record<string, unknown>;
}

interface Document {
  readonly openapi: string;
  readonly paths: Record<string, Record<string, Operation>>;
}

describe('openapi document', () => {
  /**
   * The artefact is committed and this is its guard: if a route or a schema
   * changes, the diff shows up here rather than in a client six weeks later.
   * Regenerate with `pnpm --filter @reporting/api openapi`.
   */
  it('matches the committed artefact byte for byte', () => {
    expect(renderOpenApi(ROUTES)).toBe(fs.readFileSync(COMMITTED, 'utf8'));
  });

  it('documents every registered route', () => {
    const doc = buildOpenApiDoc(ROUTES) as unknown as Document;

    expect(doc.openapi).toBe('3.1.0');

    for (const route of ROUTES) {
      const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      expect(doc.paths[path]?.[route.method]?.operationId).toBe(route.operationId);
    }
  });

  it('declares If-Match only where the handler requires it', () => {
    const doc = buildOpenApiDoc(ROUTES) as unknown as Document;

    for (const route of ROUTES) {
      const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      const parameters = doc.paths[path]?.[route.method]?.parameters ?? [];
      const hasIfMatch = parameters.some((parameter) => parameter.name === 'If-Match');

      expect(hasIfMatch).toBe(route.requiresIfMatch);
    }
  });

  it('emits no nested $schema keys, which several editors reject', () => {
    expect(JSON.stringify(buildOpenApiDoc(ROUTES))).not.toContain('"$schema"');
  });

  it('documents the problem-details shape used by every error response', () => {
    const doc = buildOpenApiDoc(ROUTES) as unknown as {
      components: { schemas: Record<string, unknown> };
    };

    expect(doc.components.schemas['ProblemDetails']).toBeDefined();
  });
});
