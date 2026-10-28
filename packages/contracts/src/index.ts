/**
 * The wire contract, shared by client and server (plan §8.1).
 *
 * Conventions fixed here rather than at each call site: `snake_case` JSON, path
 * versioning (`/v1`), RFC 9457 problem details with a stable `code`, and
 * `current_hash` as the optimistic-concurrency token. The OpenAPI 3.1 document
 * is generated from these types, never hand-kept.
 *
 * This package depends on `@reporting/tokens` on purpose: it is the one edge in
 * the workspace that proves package boundaries resolve from built output.
 */
import { type TokenDocument } from '@reporting/tokens';

export const API_VERSION = 'v1' as const;

export type ApiVersion = typeof API_VERSION;

/**
 * Report lifecycle. `amended` exists so that adding an addendum never mutates a
 * signed revision; the state machine lands with the API at P1 step 8.
 */
export type ReportState = 'draft' | 'submitted' | 'signed' | 'amended' | 'returned';

export interface ReportResource {
  readonly id: string;
  readonly state: ReportState;
  /** Pinned at creation: a report never follows a template version it was not authored on. */
  readonly template_version_id: string;
  readonly document: TokenDocument;
  /** Hash of the canonical form; also the `If-Match` value for mutation. */
  readonly current_hash: string;
}

/**
 * RFC 9457 problem details. `code` is the contract — clients branch on `code`,
 * never on `title` or on string matching `detail`.
 */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly code: string;
}

export const CONTENT_TYPE_PROBLEM = 'application/problem+json' as const;
