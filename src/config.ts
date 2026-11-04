export interface Config {
  databaseUrl: string;
  port: number;
  nodeEnv: string;
  orderServiceUrl: string;
  carrierServiceUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required (copy .env.example to .env)');
  return {
    databaseUrl,
    port: parsePort(env, 'PORT', 3000),
    nodeEnv: env.NODE_ENV ?? 'development',
    orderServiceUrl: parseHttpUrl(env, 'ORDER_SERVICE_URL', `http://127.0.0.1:${parsePort(env, 'ORDER_SERVICE_PORT', 3101)}`),
    carrierServiceUrl: parseHttpUrl(env, 'CARRIER_SERVICE_URL', `http://127.0.0.1:${parsePort(env, 'CARRIER_SERVICE_PORT', 3102)}`),
  };
}

/** Reads an http(s) base URL; unset or empty means the default. */
export function parseHttpUrl(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an http(s) URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} must be an http(s) URL`);
  return raw.replace(/\/$/, '');
}

/** Reads a TCP port from the environment; unset or empty means the default. */
export function parsePort(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) throw new Error(`${name} must be an integer 1-65535`);
  return Number(raw);
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Destructive tooling (seed, reset, test suite) runs only against a database on this
 * machine. An allow-list, so an unset or misspelled NODE_ENV cannot widen it.
 */
export function assertLocalDatabase(databaseUrl: string, what: string): void {
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new Error(`${what}: DATABASE_URL is not a valid URL`);
  }
  if (!LOCAL_HOSTS.has(host)) throw new Error(`${what} refuses to modify non-local database host "${host}"`);
}

/** The whole prototype is simulated: mock auth and dev tooling must never run in production. */
export function assertNotProduction(nodeEnv: string, what: string): void {
  if (nodeEnv === 'production') throw new Error(`${what} is a local research tool and refuses to run with NODE_ENV=production`);
}
