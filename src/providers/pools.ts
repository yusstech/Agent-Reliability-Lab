import pg from 'pg';

export type ProviderRole = 'arl_order_svc' | 'arl_carrier_svc';

/**
 * A pool whose every connection acts as the provider's database role, which has
 * privileges on that provider's schema only (ADR-0008 §1). The role is a connection
 * startup parameter, so it is in force before the first query can run.
 */
export function createProviderPool(connectionString: string, role: ProviderRole): pg.Pool {
  return new pg.Pool({ connectionString, max: 5, options: `-c role=${role}` });
}
