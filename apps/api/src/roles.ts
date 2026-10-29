import { type Actor } from './auth.js';

/**
 * The role that owns "how many people must agree on this report" (ADR-0007, D3).
 *
 * How many signatures complete a report is a governance decision, not a drafting
 * preference. Left as a free field on the create body, an author whose service requires
 * three signatures could ask for one and complete the report alone with every database
 * constraint still satisfied. The role below is who may decide instead.
 *
 * The name is provisional and it is a seam, not a design: E9 will populate roles from the
 * hospital's IdP groups, and the per-service resolver ADR-0007 anticipates will replace
 * this check with a policy lookup. Until one of those exists, an authority named in code
 * is more honest than a number chosen by the person it constrains.
 */
export const APPROVAL_AUTHORITY_ROLE = 'clinical_lead';

/** Whether this actor may set an approval requirement above 1, or lend authority. */
export function holdsApprovalAuthority(actor: Pick<Actor, 'roles'>): boolean {
  return actor.roles.includes(APPROVAL_AUTHORITY_ROLE);
}
