import { ConfigurationError } from '../errors';

// Deployment: Render. Render hands each service its Postgres URL as a plain
// `postgresql://user:password@host:port/database` connection string (Blueprint `fromDatabase`
// property `connectionString`, https://render.com/docs/blueprint-spec#referencing-service-properties)
// and a Blueprint cannot interpolate variables. Prisma needs more than that
// (https://www.prisma.io/docs/orm/v6/overview/databases/postgresql, "Arguments"):
//   schema=studio        every Studio table and _prisma_migrations live in the `studio` schema
//                        (prisma/schema.prisma `schemas = ["studio"]`); without it Prisma Migrate
//                        would look for its history in `public` and re-run the migrations.
//   connection_limit=N   Prisma 6's default pool is num_cpus * 2 + 1, and in a container that is
//                        the host's CPU count, not the plan's; the pool is sized per service so
//                        the web + worker total stays under the Render Postgres connection limit.
//   pool_timeout=N       optional; seconds to wait for a pooled connection.
//   application_name     the Render service name, so pg_stat_activity shows who holds a connection.
// scripts/render/with-db-url.sh builds DATABASE_URL with this module before exec-ing the real
// command. Error messages never contain the URL (it carries the database password).

/** Env var the Blueprint fills with Render's internal connectionString. */
export const RENDER_POSTGRES_URL_ENV = 'RENDER_POSTGRES_URL';

export const STUDIO_DB_SCHEMA = 'studio';

/** process.env or a plain object (tests). */
export type Env = Readonly<Record<string, string | undefined>>;

const MAX_CONNECTION_LIMIT = 100; // the largest Render Postgres plans still cap at a few hundred
const MAX_POOL_TIMEOUT_SEC = 300;
const APPLICATION_NAME = /^[A-Za-z0-9._-]{1,63}$/;

export interface StudioDatabaseUrlOptions {
  connectionLimit?: number;
  poolTimeoutSec?: number;
  applicationName?: string;
}

function parseSource(source: string): URL {
  let url: URL;
  try {
    url = new URL(source.trim());
  } catch {
    // Never include the input: it contains the database password.
    throw new ConfigurationError(`${RENDER_POSTGRES_URL_ENV} is not a valid URL`);
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new ConfigurationError(
      `${RENDER_POSTGRES_URL_ENV} must be a postgres:// or postgresql:// URL`,
    );
  }
  if (!url.hostname || url.pathname.replace(/^\//, '') === '') {
    throw new ConfigurationError(
      `${RENDER_POSTGRES_URL_ENV} must include a host and a database name`,
    );
  }
  return url;
}

/**
 * The URL Prisma needs, from Render's plain connection string. Existing query parameters are
 * kept; a `schema` other than `studio` is refused rather than silently replaced.
 */
export function buildStudioDatabaseUrl(
  source: string,
  options: StudioDatabaseUrlOptions = {},
): string {
  const url = parseSource(source);
  const existingSchema = url.searchParams.get('schema');
  if (existingSchema !== null && existingSchema !== STUDIO_DB_SCHEMA) {
    throw new ConfigurationError(
      `${RENDER_POSTGRES_URL_ENV} sets schema=${existingSchema}; Studio only uses the "${STUDIO_DB_SCHEMA}" schema`,
    );
  }
  url.searchParams.set('schema', STUDIO_DB_SCHEMA);
  if (options.connectionLimit !== undefined) {
    url.searchParams.set('connection_limit', String(options.connectionLimit));
  }
  if (options.poolTimeoutSec !== undefined) {
    url.searchParams.set('pool_timeout', String(options.poolTimeoutSec));
  }
  if (options.applicationName !== undefined) {
    url.searchParams.set('application_name', options.applicationName);
  }
  return url.toString();
}

function intInRange(name: string, raw: string | undefined, min: number, max: number) {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new ConfigurationError(`${name} must be a whole number from ${min} to ${max}`);
  }
  return Number(value);
}

/** Options from the service's env (STUDIO_DB_CONNECTION_LIMIT, STUDIO_DB_POOL_TIMEOUT, RENDER_SERVICE_NAME). */
export function databaseUrlOptionsFromEnv(env: Env): StudioDatabaseUrlOptions {
  const connectionLimit = intInRange(
    'STUDIO_DB_CONNECTION_LIMIT',
    env.STUDIO_DB_CONNECTION_LIMIT,
    1,
    MAX_CONNECTION_LIMIT,
  );
  const poolTimeoutSec = intInRange(
    'STUDIO_DB_POOL_TIMEOUT',
    env.STUDIO_DB_POOL_TIMEOUT,
    0,
    MAX_POOL_TIMEOUT_SEC,
  );
  const serviceName = env.RENDER_SERVICE_NAME?.trim();
  // RENDER_SERVICE_NAME is set by Render (https://render.com/docs/environment-variables). A value
  // that isn't a plain identifier is dropped rather than failing the deploy over a label.
  const applicationName =
    serviceName && APPLICATION_NAME.test(serviceName) ? serviceName : undefined;
  return {
    ...(connectionLimit !== undefined && { connectionLimit }),
    ...(poolTimeoutSec !== undefined && { poolTimeoutSec }),
    ...(applicationName !== undefined && { applicationName }),
  };
}

/** DATABASE_URL for this process, from RENDER_POSTGRES_URL plus the per-service options. */
export function studioDatabaseUrlFromEnv(env: Env): string {
  const source = env[RENDER_POSTGRES_URL_ENV]?.trim();
  if (!source) {
    throw new ConfigurationError(
      `Missing required environment variable ${RENDER_POSTGRES_URL_ENV}`,
    );
  }
  return buildStudioDatabaseUrl(source, databaseUrlOptionsFromEnv(env));
}
