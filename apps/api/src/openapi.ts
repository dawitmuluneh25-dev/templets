import { z } from 'zod';

import { API_VERSION, CONTENT_TYPE_PROBLEM } from '@reporting/contracts';

import { type RouteDefinition } from './routes.js';
import { problemDetailsSchema } from './schemas.js';

/**
 * OpenAPI 3.1, generated from the same Zod schemas the server validates with.
 *
 * Hand-kept API documents drift on the first hurried commit; a generated one
 * cannot describe an endpoint that does not exist. The output is deterministic —
 * no timestamps, no random ids, routes in declaration order — so CI can regenerate
 * it and `git diff --exit-code`, which turns "the document is current" into a test
 * rather than a review convention.
 */
const PROBLEM_REF = { $ref: '#/components/schemas/ProblemDetails' } as const;

const ERROR_RESPONSES: readonly (readonly [number, string])[] = [
  [400, 'Request body or parameters failed validation'],
  [401, 'No authenticated actor, or step-up was required and not satisfied'],
  [403, 'The actor may not perform this operation'],
  [404, 'No such resource in this tenant'],
  [409, 'The report is not in a state that permits this operation'],
  [412, "If-Match did not match the report's current_hash"],
  [428, 'If-Match is required for this operation'],
  [503, 'Step-up verification is not configured on this deployment'],
];

function toJsonSchema(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
  }) as Record<string, unknown>;

  // `$schema` is only legal at the document root; a nested copy makes several
  // editors reject the whole document.
  const copy = { ...generated };
  delete copy['$schema'];
  return copy;
}

export function buildOpenApiDoc(routes: readonly RouteDefinition[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const openApiPath = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const parameters: Record<string, unknown>[] = [];

    if (route.params !== undefined) {
      const properties = (toJsonSchema(route.params, 'input')['properties'] ?? {}) as Record<
        string,
        unknown
      >;

      for (const [name, schema] of Object.entries(properties)) {
        parameters.push({ name, in: 'path', required: true, schema });
      }
    }

    if (route.requiresIfMatch) {
      parameters.push({
        name: 'If-Match',
        in: 'header',
        required: true,
        description: "The report's current_hash, as returned by the last read or write.",
        schema: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
      });
    }

    const responses: Record<string, unknown> = {
      [String(route.okStatus)]: {
        description: 'Success',
        content: {
          'application/json': { schema: toJsonSchema(route.okSchema, 'output') },
        },
      },
    };

    for (const [status, description] of ERROR_RESPONSES) {
      responses[String(status)] = {
        description,
        content: { [CONTENT_TYPE_PROBLEM]: { schema: PROBLEM_REF } },
      };
    }

    const operation: Record<string, unknown> = {
      operationId: route.operationId,
      summary: route.summary,
      ...(parameters.length === 0 ? {} : { parameters }),
      ...(route.body === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: toJsonSchema(route.body, 'input') },
              },
            },
          }),
      responses,
    };

    const existing = paths[openApiPath] ?? {};
    existing[route.method] = operation;
    paths[openApiPath] = existing;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Radiology Reporting API',
      version: API_VERSION,
      description:
        'Generated from the request and response schemas in apps/api/src/schemas.ts. ' +
        'Errors are RFC 9457 problem details; branch on `code`, never on `title`.',
    },
    paths,
    components: {
      schemas: { ProblemDetails: toJsonSchema(problemDetailsSchema, 'output') },
    },
  };
}

/** The committed artefact's exact bytes. One trailing newline, two-space indent. */
export function renderOpenApi(routes: readonly RouteDefinition[]): string {
  return `${JSON.stringify(buildOpenApiDoc(routes), null, 2)}\n`;
}
