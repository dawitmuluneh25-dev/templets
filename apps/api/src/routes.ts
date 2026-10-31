import { type ZodType } from 'zod';

import { type Actor } from './auth.js';
import { createApprovalPolicy, listApprovalPolicies } from './domain/approval-policy.js';
import { createDelegation } from './domain/delegation-service.js';
import {
  createReport,
  getReport,
  saveDraft,
  signReport,
  type ReportServiceDeps,
} from './domain/report-service.js';
import {
  approvalPolicyListSchema,
  approvalPolicyResourceSchema,
  createApprovalPolicyBodySchema,
  createDelegationBodySchema,
  createReportBodySchema,
  delegationResourceSchema,
  reportParamsSchema,
  reportResourceSchema,
  saveDraftBodySchema,
  signBodySchema,
} from './schemas.js';

/**
 * One table, two consumers: the HTTP layer registers from it and the OpenAPI
 * document is generated from it. A route cannot exist in one and not the other,
 * which is the failure mode of hand-written API docs.
 */
export interface RouteContext {
  readonly actor: Actor;
  readonly deps: ReportServiceDeps;
  readonly params: Readonly<Record<string, string>>;
  readonly body: unknown;
  /** Present only when `requiresIfMatch` is set. */
  readonly ifMatch: string;
}

export interface RouteDefinition {
  readonly method: 'get' | 'post' | 'put';
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly body: ZodType | undefined;
  readonly params: ZodType | undefined;
  readonly okStatus: 200 | 201;
  readonly okSchema: ZodType;
  readonly requiresIfMatch: boolean;
  readonly handler: (context: RouteContext) => Promise<unknown>;
}

export const ROUTES: readonly RouteDefinition[] = [
  {
    method: 'post',
    path: '/v1/reports',
    operationId: 'createReport',
    summary: 'Create a draft report from a pinned template version',
    body: createReportBodySchema,
    params: undefined,
    okStatus: 201,
    okSchema: reportResourceSchema,
    requiresIfMatch: false,
    handler: async ({ actor, deps, body }) => {
      const input = createReportBodySchema.parse(body);

      return createReport(deps, {
        actor,
        templateVersionId: input.template_version_id,
        studyInstanceUid: input.study_instance_uid,
        accession: input.accession,
        modality: input.modality,
        fieldValues: input.field_values ?? {},
      });
    },
  },
  {
    method: 'post',
    path: '/v1/approval-policies',
    operationId: 'createApprovalPolicy',
    summary: 'Set how many signatures reports in this tenant require',
    body: createApprovalPolicyBodySchema,
    params: undefined,
    okStatus: 201,
    okSchema: approvalPolicyResourceSchema,
    requiresIfMatch: false,
    handler: async ({ actor, deps, body }) => {
      const input = createApprovalPolicyBodySchema.parse(body);

      return createApprovalPolicy(
        { pool: deps.pool },
        {
          actor,
          templateId: input.template_id,
          modality: input.modality,
          approvalsRequired: input.approvals_required,
          rationale: input.rationale,
        },
      );
    },
  },
  {
    method: 'get',
    path: '/v1/approval-policies',
    operationId: 'listApprovalPolicies',
    summary: 'Read the approval rules in force for this tenant',
    body: undefined,
    params: undefined,
    okStatus: 200,
    okSchema: approvalPolicyListSchema,
    requiresIfMatch: false,
    handler: async ({ actor, deps }) => listApprovalPolicies({ pool: deps.pool }, actor),
  },
  {
    method: 'post',
    path: '/v1/delegations',
    operationId: 'createDelegation',
    summary: 'Lend authority to sign, to one person, until a date',
    body: createDelegationBodySchema,
    params: undefined,
    okStatus: 201,
    okSchema: delegationResourceSchema,
    requiresIfMatch: false,
    handler: async ({ actor, deps, body }) => {
      const input = createDelegationBodySchema.parse(body);

      return createDelegation(deps, {
        actor,
        // Spread rather than assign: `exactOptionalPropertyTypes` distinguishes "absent"
        // from "present and undefined", and absent is what "lend your own authority" means.
        ...(input.from_user_id === undefined ? {} : { fromUserId: input.from_user_id }),
        toUserId: input.to_user_id,
        expiresAt: input.expires_at,
      });
    },
  },
  {
    method: 'get',
    path: '/v1/reports/:id',
    operationId: 'getReport',
    summary: 'Read a report with its latest revision',
    body: undefined,
    params: reportParamsSchema,
    okStatus: 200,
    okSchema: reportResourceSchema,
    requiresIfMatch: false,
    handler: async ({ actor, deps, params }) => getReport(deps, actor, params.id ?? ''),
  },
  {
    method: 'put',
    path: '/v1/reports/:id/draft',
    operationId: 'saveDraft',
    summary: 'Append a draft revision (autosave)',
    body: saveDraftBodySchema,
    params: reportParamsSchema,
    okStatus: 200,
    okSchema: reportResourceSchema,
    requiresIfMatch: true,
    handler: async ({ actor, deps, params, body, ifMatch }) => {
      const input = saveDraftBodySchema.parse(body);

      return saveDraft(deps, {
        actor,
        reportId: params.id ?? '',
        ifMatch,
        fieldValues: input.field_values,
      });
    },
  },
  {
    method: 'post',
    path: '/v1/reports/:id/sign',
    operationId: 'signReport',
    summary: 'Sign the current revision with a step-up assertion',
    body: signBodySchema,
    params: reportParamsSchema,
    okStatus: 200,
    okSchema: reportResourceSchema,
    requiresIfMatch: true,
    handler: async ({ actor, deps, params, body, ifMatch }) => {
      const input = signBodySchema.parse(body);

      return signReport(deps, {
        actor,
        reportId: params.id ?? '',
        ifMatch,
        stepUpAssertion: input.step_up_token,
        onBehalfOf: input.on_behalf_of,
      });
    },
  },
];
