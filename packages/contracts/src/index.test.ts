import { describe, expect, it } from 'vitest';

import { TOKEN_SCHEMA_VERSION } from '@reporting/tokens';

import {
  API_VERSION,
  CONTENT_TYPE_PROBLEM,
  type ProblemDetails,
  type ReportResource,
} from './index.js';

describe('wire contract', () => {
  it('pins the API version in the path', () => {
    expect(API_VERSION).toBe('v1');
  });

  it('carries a token document and its hash', () => {
    const report: ReportResource = {
      id: '8f14e45f-ea4a-4c1f-9d0e-3b1f2a6c9d10',
      state: 'draft',
      template_version_id: 'a1b2c3d4-0000-4000-8000-000000000000',
      revision: 1,
      approvals_required: 1,
      signatures: [],
      current_hash: 'sha256:0f3c…',
      document: {
        schema_version: TOKEN_SCHEMA_VERSION,
        tokens: [{ kind: 'text', value: 'XR Chest' }],
      },
      field_values: {},
      signed_at: null,
    };

    expect(report.document.tokens).toHaveLength(1);
    expect(report.current_hash).toMatch(/^sha256:/);
  });

  it('uses problem+json with a stable code, not a message for branching', () => {
    const problem: ProblemDetails = {
      type: 'https://errors.example/hash-mismatch',
      title: 'Report has changed since it was read',
      status: 409,
      code: 'report_hash_mismatch',
    };

    expect(CONTENT_TYPE_PROBLEM).toBe('application/problem+json');
    expect(problem.status).toBe(409);
    expect(problem.code).toBe('report_hash_mismatch');
  });
});
