import pg from 'pg';

/** A connection inside a tenant-scoped transaction. Never held past the callback. */
export type Tx = pg.PoolClient;

export interface TenantContext {
  readonly orgId: string;
  /** Recorded for the audit trail; RLS itself only needs `orgId`. */
  readonly actorId?: string | null;
}

/**
 * Runs `fn` in a transaction whose tenant is set, and nowhere else.
 *
 * `set_config(..., true)` is transaction-local: the setting is reverted at
 * `commit`, so a pooled connection cannot carry one request's tenant into the
 * next. That is the whole reason the tenant is set here rather than by a
 * connection-level `SET` — a leaked `app.org_id` on a pooled connection is
 * cross-tenant access that no policy can catch.
 *
 * `app_current_org()` raises when the setting is missing, so forgetting this
 * wrapper fails loudly instead of returning an empty result set that looks like
 * an empty database.
 */
export async function withTenant<T>(
  pool: pg.Pool,
  context: TenantContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('begin');
    await client.query("select set_config('app.org_id', $1, true)", [context.orgId]);

    if (context.actorId !== undefined && context.actorId !== null) {
      await client.query("select set_config('app.actor_id', $1, true)", [context.actorId]);
    }

    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * A pool with the behaviour this workload needs.
 *
 * `application_name` is set so a DBA can tell API connections apart from
 * migration and test connections in `pg_stat_activity` — during an incident
 * that is the difference between a five-minute and a one-hour diagnosis.
 */
export function createPool(connectionString: string, applicationName = 'reporting'): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    application_name: applicationName,
  });
}
