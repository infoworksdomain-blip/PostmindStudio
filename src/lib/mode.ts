import { ConfigurationError } from './errors';

// Phase 18 §0 — which integrations Studio uses. STUDIO_MODE=standalone (the default) is the
// Core-free product; STUDIO_MODE=core keeps the pre-Phase-18 behaviour. Each integration can be
// overridden on its own. Adapters are chosen ONCE (context.ts / create-deps.ts / identity/index.ts)
// from these values, so mode checks are not scattered through the code.

export type StudioMode = 'standalone' | 'core';

export interface StudioModes {
  mode: StudioMode;
  /** Who signs users in: Better Auth (standalone) or Core's JWKS JWT + context (core). */
  identity: 'standalone' | 'core';
  /** Where audit entries go: studio.audit_log, Core's audit service, or both. */
  auditSink: 'local' | 'core' | 'both';
  email: 'resend' | 'core' | 'none';
  /** Meta (Facebook / Instagram) tokens: Studio's own OAuth or pushed by Core. */
  metaConnect: 'studio' | 'core';
  /** Plan tier and access: Stripe subscriptions or Core's planTier. */
  billing: 'stripe' | 'core';
  /** The business list: studio.businesses or Core's (pending) directory. */
  businesses: 'local' | 'core';
}

type Env = Record<string, string | undefined>;

const DEFAULTS: Record<StudioMode, Omit<StudioModes, 'mode'>> = {
  standalone: {
    identity: 'standalone',
    auditSink: 'local',
    email: 'resend',
    metaConnect: 'studio',
    billing: 'stripe',
    businesses: 'local',
  },
  core: {
    identity: 'core',
    auditSink: 'core',
    // Pre-Phase-18 behaviour: unset STUDIO_EMAIL_PROVIDER meant no sender (pending setup).
    email: 'none',
    metaConnect: 'core',
    billing: 'core',
    businesses: 'core',
  },
};

function pick<T extends string>(env: Env, name: string, allowed: readonly T[], fallback: T): T {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new ConfigurationError(`${name} must be one of ${allowed.join(' | ')} (got "${raw}")`);
}

/** Resolve every mode from env. Invalid values throw: a typo must not silently pick a mode. */
export function studioModes(env: Env = process.env): StudioModes {
  const mode = pick(env, 'STUDIO_MODE', ['standalone', 'core'] as const, 'standalone');
  const d = DEFAULTS[mode];
  return {
    mode,
    identity: pick(env, 'STUDIO_IDENTITY_MODE', ['standalone', 'core'] as const, d.identity),
    auditSink: pick(env, 'STUDIO_AUDIT_SINK', ['local', 'core', 'both'] as const, d.auditSink),
    email: pick(env, 'STUDIO_EMAIL_PROVIDER', ['resend', 'core', 'none'] as const, d.email),
    metaConnect: pick(env, 'STUDIO_META_CONNECT', ['studio', 'core'] as const, d.metaConnect),
    billing: pick(env, 'STUDIO_BILLING', ['stripe', 'core'] as const, d.billing),
    businesses: pick(env, 'STUDIO_BUSINESSES', ['local', 'core'] as const, d.businesses),
  };
}
