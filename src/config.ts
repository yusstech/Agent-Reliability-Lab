export interface Config {
  databaseUrl: string;
  port: number;
  nodeEnv: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required (copy .env.example to .env)');
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer 1-65535');
  return { databaseUrl, port, nodeEnv: env.NODE_ENV ?? 'development' };
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
