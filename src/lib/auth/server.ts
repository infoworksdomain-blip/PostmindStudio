import { Redis } from 'ioredis';
import { auditLogDurable } from '../audit';
import { authMailerFromEnv } from '../email/auth-mailer';
import { requireEnv } from '../env';
import { logger } from '../logger';
import { prisma } from '../prisma';
import { entitlementsReaderFromEnv } from '../studio/billing/entitlements-reader';
import { redisConnectionFromEnv } from '../studio/queue/redis';
import { createAuth, type StudioAuth } from './config';
import { createRedisAuthRateLimitStore } from './rate-limit-store';

// Phase 18 §2.1: the process's Better Auth instance, built once from env (standalone mode only;
// core mode never loads this module).

let instance: Promise<StudioAuth> | undefined;

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function build(): Promise<StudioAuth> {
  const appUrl = process.env.BETTER_AUTH_URL?.trim() || requireEnv('APP_URL');
  const redis = new Redis({
    ...(redisConnectionFromEnv() as object),
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  redis.on('error', () => undefined);
  const googleId = process.env.GOOGLE_CLIENT_ID?.trim();
  const googleSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const log = logger.child({ component: 'auth' });
  const { getIdentityProvider } = await import('../identity');
  return createAuth({
    db: prisma,
    secret: requireEnv('BETTER_AUTH_SECRET'),
    baseURL: appUrl,
    mailer: await authMailerFromEnv(log),
    logger: log,
    rateLimitStore: createRedisAuthRateLimitStore(redis, {
      onError: (err) => log.warn({ err }, 'auth rate limiter unavailable; failing open'),
    }),
    entitlements: await entitlementsReaderFromEnv(),
    audit: auditLogDurable,
    ...(googleId && googleSecret && { google: { clientId: googleId, clientSecret: googleSecret } }),
    signupsEnabled: process.env.STUDIO_SIGNUPS_ENABLED?.trim() !== 'false',
    breachCheck: process.env.STUDIO_HIBP_CHECK?.trim() !== 'false',
    trustedProxies: list(process.env.STUDIO_AUTH_TRUSTED_PROXIES),
    impersonationEnabled: process.env.STUDIO_IMPERSONATION_ENABLED?.trim() === 'true',
    secureCookies: appUrl.startsWith('https://'),
    onIdentityChanged: (userId) => {
      void getIdentityProvider()
        .then((p) => p.invalidate(userId))
        .catch(() => undefined);
    },
  });
}

export function getAuth(): Promise<StudioAuth> {
  instance ??= build().catch((err: unknown) => {
    instance = undefined;
    throw err;
  });
  return instance;
}
