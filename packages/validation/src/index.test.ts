import { describe, expect, it } from 'vitest';

import { VALIDATION_SCHEMA_VERSION, summarize, type ValidationIssue } from './index.js';

const issue = (severity: ValidationIssue['severity'], section: string | null): ValidationIssue => ({
  id: `${severity}:${section ?? 'report'}`,
  severity,
  code: 'section_empty',
  section_key: section,
  message: 'IMPRESSION is empty. This template includes that section.',
});

describe('validation summary', () => {
  it('pins the schema version', () => {
    expect(VALIDATION_SCHEMA_VERSION).toBe(1);
  });

  it('counts an empty report as clean', () => {
    expect(summarize([])).toEqual({ blocking: 0, confirm: 0, advisory: 0 });
  });

  it('keeps the three tiers distinct', () => {
    const summary = summarize([
      issue('blocking', 'IMPRESSION'),
      issue('blocking', 'FINDINGS'),
      issue('advisory', null),
    ]);

    expect(summary).toEqual({ blocking: 2, confirm: 0, advisory: 1 });
  });
});
