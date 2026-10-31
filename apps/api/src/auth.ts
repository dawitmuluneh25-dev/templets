import { type Pool } from 'pg';
import { type FastifyRequest } from 'fastify';

import { withTenant } from '@reporting/db';

/**
 * Who is acting, and what proves it.
 *
 * Two seams, both deliberately empty today:
 *
 * - **Identity** is the hospital's IdP (ADR-0006: never build credentials). Entry
 *   condition E9 — role groups and step-up — is not confirmed, so the only
 *   authenticator here resolves a subject from a header and says so in its
 *   `description`. It is development wiring, it refuses to run with
 *   `NODE_ENV=production`, and it does not pretend to have verified anything.
 * - **Step-up** is the same story. The default verifier is *unavailable* and the
 *   sign endpoint fails closed with 503, which is the truthful state of a system
 *   whose IdP integration does not exist yet. A test verifier exists for the
 *   contract test; nothing in `main.ts` can wire it.
 *
 * The alternative — a stub that accepts any password-shaped string — would make
 * the vertical slice look finished while making every signature in it worthless.
 */
export interface Actor {
  readonly orgId: string;
  readonly userId: string;
  readonly idpSubject: string;
  readonly roles: readonly string[];
}

export interface Authenticator {
  /** Printed at boot, so the running deployment's auth mode is not a mystery. */
  readonly description: string;
  authenticate(request: FastifyRequest): Promise<Actor | null>;
}

/** Fail-closed default: no identity provider is configured, so nobody is anyone. */
export class DenyAllAuthenticator implements Authenticator {
  readonly description = 'none — OIDC wiring is entry condition E9; every request will be 401';

  async authenticate(): Promise<Actor | null> {
    return null;
  }
}

/**
 * Development only: the subject arrives in a header.
 *
 * Everything after the claim is real — the user is looked up in `app_user` under
 * the tenant's row-level security, and a subject with no active row is nobody.
 * What is absent is the part a header cannot provide: proof that the request came
 * from that subject.
 */
export class HeaderAuthenticator implements Authenticator {
  readonly description: string;

  constructor(
    private readonly pool: Pool,
    private readonly orgId: string,
  ) {
    this.description = 'header x-actor-subject — DEVELOPMENT ONLY, not an authentication check';
  }

  async authenticate(request: FastifyRequest): Promise<Actor | null> {
    const subject = request.headers['x-actor-subject'];
    if (typeof subject !== 'string' || subject === '') return null;

    return withTenant(this.pool, { orgId: this.orgId }, async (tx) => {
      const row = await tx.query<{ id: string; idp_subject: string; roles: string[] }>(
        'select id, idp_subject, roles from app_user where idp_subject = $1 and active',
        [subject],
      );

      const user = row.rows[0];
      if (user === undefined) return null;

      return {
        orgId: this.orgId,
        userId: user.id,
        idpSubject: user.idp_subject,
        roles: user.roles,
      };
    });
  }
}

export type SignatureMethod = 'password_step_up' | 'sso_step_up' | 'hardware_key';

export interface StepUpRequest {
  readonly purpose: 'report.sign';
  readonly reportId: string;
  /** The hash the signature will attest. Bound into the assertion, not just the session. */
  readonly contentHash: string;
}

export interface StepUpGrant {
  readonly method: SignatureMethod;
  /** Recorded verbatim on the signature row: which verifier, which moment, which subject. */
  readonly authContext: Readonly<Record<string, unknown>>;
}

export interface StepUpVerifier {
  readonly available: boolean;
  readonly description: string;
  /**
   * `assertion` is the value the client presented (a step-up token). `undefined`
   * means none was presented, which is not the same as a wrong one and is
   * reported as `step_up_required` rather than as a failure.
   */
  verify(
    actor: Actor,
    request: StepUpRequest,
    assertion: string | undefined,
  ): Promise<StepUpGrant | null>;
}

export class UnconfiguredStepUp implements StepUpVerifier {
  readonly available = false;
  readonly description = 'none — signing is disabled until the IdP step-up flow exists (E9)';

  async verify(): Promise<StepUpGrant | null> {
    return null;
  }
}

/**
 * Test double. Named so that it cannot be mistaken for a verifier in a review or
 * imported by `main.ts` without the name being visible in the diff.
 */
export class TestOnlyFixedTokenStepUp implements StepUpVerifier {
  readonly available = true;
  readonly description = 'fixed test token — TEST ONLY';

  constructor(private readonly token: string) {}

  async verify(
    actor: Actor,
    request: StepUpRequest,
    assertion: string | undefined,
  ): Promise<StepUpGrant | null> {
    if (assertion !== this.token) return null;

    return {
      method: 'sso_step_up',
      authContext: {
        verifier: 'test-only-fixed-token',
        purpose: request.purpose,
        report_id: request.reportId,
        content_hash: request.contentHash,
        idp_subject: actor.idpSubject,
      },
    };
  }
}
