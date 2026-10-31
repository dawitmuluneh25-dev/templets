/**
 * Persistence surface.
 *
 * The shape is deliberate: callers get a tenant-scoped transaction and the audit
 * append, and nothing else. Handing out a bare pool would let a caller run a
 * query without `app.org_id` set — which either raises or, worse, runs as
 * whatever role the URL names. Tenant context is not a convention here; it is
 * the only entry point.
 */
export { MIGRATIONS_DIR, runMigrations, type MigrationResult } from './migrate.js';
export { createPool, withTenant, type TenantContext, type Tx } from './tenant.js';
export {
  AUDIT_SCHEMA_VERSION,
  appendAudit,
  checkAuditChain,
  readAuditTrail,
  verifyChain,
  type AppendedAudit,
  type AuditEventInput,
  type AuditTrailEntry,
  type ChainCheck,
} from './audit.js';
