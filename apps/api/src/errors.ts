import { type ProblemDetails } from '@reporting/contracts';

/**
 * One error type, mapped once.
 *
 * `code` is the contract clients branch on (RFC 9457 says the same); `title` and
 * `detail` are for humans and may be reworded without notice. The `type` URN is
 * derived from the code so the two can never drift apart.
 *
 * `detail` must never contain PHI. Field values are echoed nowhere: a validation
 * failure names the JSON path, not the value that failed.
 */
export type ProblemCode =
  | 'invalid_request'
  | 'not_authenticated'
  | 'step_up_required'
  | 'step_up_unavailable'
  | 'forbidden'
  | 'not_found'
  | 'report_not_found'
  | 'template_version_not_found'
  | 'report_not_editable'
  | 'report_already_signed'
  | 'report_not_submitted'
  | 'already_signed'
  | 'no_approval_policy'
  | 'no_active_delegation'
  | 'report_not_signed'
  | 'delivery_failed'
  | 'revision_mismatch'
  | 'precondition_required'
  | 'precondition_failed'
  | 'internal_error';

const TITLES: Readonly<Record<ProblemCode, string>> = {
  invalid_request: 'Request body failed validation',
  not_authenticated: 'Authentication required',
  step_up_required: 'Step-up authentication required',
  step_up_unavailable: 'Step-up authentication is not configured',
  forbidden: 'Not permitted for this actor',
  not_found: 'No such endpoint',
  report_not_found: 'Report not found',
  template_version_not_found: 'Template version not found',
  report_not_editable: 'Report is not editable in its current state',
  report_already_signed: 'Report is already signed',
  report_not_submitted: 'Report has not been submitted for approval',
  already_signed: 'This revision already carries your signature',
  no_approval_policy: 'No approval policy covers this report',
  no_active_delegation: 'No cover is in force for this signature',
  report_not_signed: 'Only a signed report can be delivered',
  delivery_failed: 'Delivery to the external system failed',
  revision_mismatch: 'Report content does not match its latest revision',
  precondition_required: 'If-Match header required',
  precondition_failed: 'If-Match does not match the current hash',
  internal_error: 'Internal error',
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  readonly detail: string | undefined;

  constructor(code: ProblemCode, status: number, detail?: string) {
    super(detail ?? TITLES[code]);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }

  toProblem(instance?: string): ProblemDetails {
    return {
      type: `urn:reporting:error:${this.code}`,
      title: TITLES[this.code],
      status: this.status,
      code: this.code,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
      ...(instance === undefined ? {} : { instance }),
    };
  }
}

export const problems = {
  invalidRequest: (detail: string) => new ApiError('invalid_request', 400, detail),
  notAuthenticated: (detail: string) => new ApiError('not_authenticated', 401, detail),
  stepUpRequired: (detail: string) => new ApiError('step_up_required', 401, detail),
  stepUpUnavailable: (detail: string) => new ApiError('step_up_unavailable', 503, detail),
  forbidden: (detail: string) => new ApiError('forbidden', 403, detail),
  reportNotFound: (id: string) => new ApiError('report_not_found', 404, `No report ${id}.`),
  templateVersionNotFound: (id: string) =>
    new ApiError('template_version_not_found', 404, `No template version ${id}.`),
  reportNotEditable: (state: string) =>
    new ApiError('report_not_editable', 409, `A report in state "${state}" cannot be edited.`),
  reportAlreadySigned: () => new ApiError('report_already_signed', 409, 'This report is signed.'),
  reportNotSubmitted: () =>
    new ApiError(
      'report_not_submitted',
      409,
      'The author must sign this report before anyone can approve it.',
    ),
  alreadySigned: (detail: string) => new ApiError('already_signed', 409, detail),
  noApprovalPolicy: (detail: string) => new ApiError('no_approval_policy', 409, detail),
  noActiveDelegation: (detail: string) => new ApiError('no_active_delegation', 409, detail),
  reportNotSigned: (detail: string) => new ApiError('report_not_signed', 409, detail),
  deliveryFailed: (detail: string) => new ApiError('delivery_failed', 502, detail),
  revisionMismatch: (detail: string) => new ApiError('revision_mismatch', 409, detail),
  preconditionRequired: () =>
    new ApiError('precondition_required', 428, "Send If-Match with the report's current_hash."),
  preconditionFailed: () =>
    new ApiError('precondition_failed', 412, 'The report changed since it was read.'),
  internal: (detail: string) => new ApiError('internal_error', 500, detail),
};
