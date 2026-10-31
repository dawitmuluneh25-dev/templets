/**
 * Validation findings and their severity.
 *
 * Three tiers, matching the prototype's status bar ("2 blocking · 0 to confirm ·
 * 0 advisory"): `blocking` stops signing, `confirm` requires an explicit
 * acknowledgement that is recorded as evidence, `advisory` is informational.
 *
 * The rules themselves are not implemented here — they depend on a pinned
 * template version and land with the editor. What this package fixes is the
 * vocabulary, so a rule cannot invent a fourth tier at the call site.
 */

export const VALIDATION_SCHEMA_VERSION = 1 as const;

export type ValidationSchemaVersion = typeof VALIDATION_SCHEMA_VERSION;

export type Severity = 'blocking' | 'confirm' | 'advisory';

export interface ValidationIssue {
  /** Stable per rule and location, so an acknowledgement can reference it. */
  readonly id: string;
  readonly severity: Severity;
  /** Machine-readable rule code, e.g. `section_empty`. */
  readonly code: string;
  /** Section key the issue attaches to; `null` for report-level findings. */
  readonly section_key: string | null;
  /** Operator-facing text. Never contains PHI. */
  readonly message: string;
}

export interface ValidationSummary {
  readonly blocking: number;
  readonly confirm: number;
  readonly advisory: number;
}

/** Counts by tier. Signing is gated on `blocking === 0` and `confirm === 0`. */
export function summarize(issues: readonly ValidationIssue[]): ValidationSummary {
  const summary = { blocking: 0, confirm: 0, advisory: 0 };

  for (const issue of issues) {
    summary[issue.severity] += 1;
  }

  return summary;
}
