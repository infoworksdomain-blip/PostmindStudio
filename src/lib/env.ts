import { ConfigurationError } from './errors';
import { studioModes, type StudioModes } from './mode';

/** Read a required env var. Throws (never returns a fallback) so misconfiguration fails fast. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new ConfigurationError(`Missing required environment variable ${name}`);
  }
  return value;
}

type Env = Record<string, string | undefined>;

/** A key the web process needs in this mode, with an optional minimum length (secrets). */
export interface RequiredEnvKey {
  name: string;
  minLength?: number;
}

const SECRET_MIN_LENGTH = 32;

/**
 * Phase 18 §6: the env keys the web process cannot run without, by mode. Standalone needs the
 * auth secret, Stripe and Resend; core needs PostMind Core's URLs and service token. Keys that
 * only switch a feature on (Google sign-in, Meta connect, HIBP) are not here: the feature is
 * hidden when they are unset.
 */
export function requiredEnvForModes(modes: StudioModes): RequiredEnvKey[] {
  const keys: RequiredEnvKey[] = [{ name: 'DATABASE_URL' }, { name: 'APP_URL' }];
  if (modes.identity === 'standalone') {
    keys.push({ name: 'BETTER_AUTH_SECRET', minLength: SECRET_MIN_LENGTH });
  } else {
    keys.push(
      { name: 'POSTMIND_CORE_URL' },
      { name: 'POSTMIND_JWKS_URL' },
      { name: 'POSTMIND_JWT_ISSUER' },
      { name: 'POSTMIND_JWT_AUDIENCE' },
      { name: 'POSTMIND_SERVICE_TOKEN' },
    );
  }
  if (modes.auditSink !== 'local') {
    keys.push({ name: 'POSTMIND_AUDIT_URL' }, { name: 'POSTMIND_SERVICE_TOKEN' });
  }
  if (modes.billing === 'stripe') {
    keys.push({ name: 'STRIPE_SECRET_KEY' }, { name: 'STRIPE_WEBHOOK_SECRET' });
  }
  if (modes.email === 'resend') {
    keys.push(
      { name: 'RESEND_API_KEY' },
      { name: 'RESEND_WEBHOOK_SECRET' },
      { name: 'STUDIO_EMAIL_FROM' },
      { name: 'STUDIO_UNSUBSCRIBE_SECRET', minLength: SECRET_MIN_LENGTH },
    );
  }
  const seen = new Set<string>();
  return keys.filter((k) => !seen.has(k.name) && (seen.add(k.name), true));
}

/** Problems with the required set: missing keys and secrets that are too short. */
export function missingRequiredEnv(env: Env = process.env): string[] {
  return requiredEnvForModes(studioModes(env)).flatMap((key) => {
    const value = env[key.name]?.trim() ?? '';
    if (value === '') return [`${key.name} is not set`];
    if (key.minLength && value.length < key.minLength) {
      return [`${key.name} must be at least ${key.minLength} characters`];
    }
    return [];
  });
}

/**
 * Fail fast at start-up (src/instrumentation.ts, production only): an invalid mode or a missing
 * required key stops the process with every problem listed, instead of failing on first use.
 */
export function assertStartupEnv(env: Env = process.env): void {
  const problems = missingRequiredEnv(env);
  if (problems.length > 0) {
    throw new ConfigurationError(
      `Studio cannot start (STUDIO_MODE=${studioModes(env).mode}): ${problems.join('; ')}`,
      { problems },
    );
  }
}
