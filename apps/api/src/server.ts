import { type Pool } from 'pg';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { CONTENT_TYPE_PROBLEM } from '@reporting/contracts';

import { type Authenticator, type StepUpVerifier } from './auth.js';
import { ApiError, problems } from './errors.js';
import { ROUTES } from './routes.js';

export interface ServerDeps {
  readonly pool: Pool;
  readonly authenticator: Authenticator;
  readonly stepUp: StepUpVerifier;
  readonly logger?: boolean;
}

/**
 * The HTTP surface.
 *
 * Deliberate choices, each one a decision rather than a default:
 *
 * - **Every route authenticates, including reads.** A read endpoint that forgets
 *   is a PHI disclosure; making the check part of the registration path means
 *   there is no route that can forget.
 * - **Bodies are not logged.** Fastify does not log request bodies by default and
 *   this stays that way: a field value is clinical text. Correlating a request by
 *   id is enough to investigate a failure.
 * - **Errors never echo input.** A 400 names the JSON path and the rule code; it
 *   never repeats the value that failed.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger:
      deps.logger === true
        ? {
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers["x-actor-subject"]',
                'res.headers["set-cookie"]',
              ],
              remove: true,
            },
          }
        : false,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      reply.type(CONTENT_TYPE_PROBLEM).status(error.status).send(error.toProblem(request.url));
      return;
    }

    if (error instanceof ZodError) {
      reply
        .type(CONTENT_TYPE_PROBLEM)
        .status(400)
        .send(problems.invalidRequest(describeZodError(error)).toProblem(request.url));
      return;
    }

    request.log.error({ err: error }, 'unhandled request error');
    reply
      .type(CONTENT_TYPE_PROBLEM)
      .status(500)
      .send(problems.internal('An unexpected error occurred.').toProblem(request.url));
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .type(CONTENT_TYPE_PROBLEM)
      .status(404)
      .send(
        new ApiError('not_found', 404, `No route for ${request.method} ${request.url}.`).toProblem(
          request.url,
        ),
      );
  });

  for (const route of ROUTES) {
    app.route({
      method: route.method.toUpperCase() as 'GET' | 'POST' | 'PUT',
      url: route.path,
      handler: async (request, reply) => {
        const actor = await deps.authenticator.authenticate(request);

        if (actor === null) {
          throw problems.notAuthenticated(
            'No authenticated actor. This deployment has no identity provider configured (E9).',
          );
        }

        const params =
          route.params === undefined
            ? {}
            : (route.params.parse(request.params) as Record<string, string>);

        const result = await route.handler({
          actor,
          deps: { pool: deps.pool, stepUp: deps.stepUp },
          params,
          body: request.body ?? {},
          ifMatch: route.requiresIfMatch ? readIfMatch(request) : '',
        });

        reply.status(route.okStatus).send(result);
      },
    });
  }

  return app;
}

/**
 * `If-Match` must be a strong validator. A weak one (`W/"..."`) says the content
 * is *equivalent*, which is not what a caller needs to claim before overwriting a
 * clinical draft.
 */
function readIfMatch(request: FastifyRequest): string {
  const header = request.headers['if-match'];

  if (header === undefined) throw problems.preconditionRequired();
  if (typeof header !== 'string') throw problems.invalidRequest('If-Match must be a single value.');

  const value = header.trim();
  if (value === '') throw problems.preconditionRequired();
  if (value.startsWith('W/')) {
    throw problems.preconditionFailed();
  }

  return value.replace(/^"(.*)"$/, '$1');
}

function describeZodError(error: ZodError): string {
  const parts = error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.length === 0 ? '(root)' : issue.path.join('.');
    return `${path}: ${issue.code}`;
  });

  return `Invalid request: ${parts.join('; ')}`;
}
