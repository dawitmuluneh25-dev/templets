/**
 * Public surface of the API package.
 *
 * The domain functions are exported alongside the HTTP server so that the vertical
 * slice can be tested without a socket, and so a worker or a job can reuse the
 * same transaction bodies. Two implementations of "sign a report" would be two
 * places for the audit event to be forgotten.
 */
export {
  createReport,
  getReport,
  saveDraft,
  signReport,
  type CreateReportInput,
  type ReportServiceDeps,
  type SaveDraftInput,
  type SignReportInput,
} from './domain/report-service.js';

export {
  DenyAllAuthenticator,
  HeaderAuthenticator,
  TestOnlyFixedTokenStepUp,
  UnconfiguredStepUp,
  type Actor,
  type Authenticator,
  type SignatureMethod,
  type StepUpGrant,
  type StepUpRequest,
  type StepUpVerifier,
} from './auth.js';

export { ApiError, problems, type ProblemCode } from './errors.js';
export { ROUTES, type RouteDefinition } from './routes.js';
export { buildOpenApiDoc, renderOpenApi } from './openapi.js';
export { buildServer, type ServerDeps } from './server.js';
