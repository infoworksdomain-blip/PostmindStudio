import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { FeatureDisabledError } from '../../errors';
import { logger } from '../../logger';
import { createPrismaFlagStore, KILL_SWITCH_CACHE_TTL_MS, type FlagStore } from '../kill-switch';
import { FLAG_OFF, FLAG_ON } from '../system-flags';

// BACKLOG 15.D1 / Addendum A12.4: "Any feature can be disabled per-org or globally within 60
// seconds via SystemFlag toggle." Four v1.1 features are switchable:
//
//   studio.features.<feature>                    'false' = off for everyone (absent/'true' = on)
//   studio.features.<feature>.org.<organisationId> 'false' = off for that organisation
//
// plus a per-environment hard off from FEATURE_<NAME>_ENABLED="false" (.env.example), which the
// flags cannot override. Reads are cached for 30 s per process (the kill-switch TTL), so a toggle
// takes effect everywhere within 30 s; the admin API invalidates its own process immediately.
// Unrecognised flag values fail closed (the feature is treated as off) and are logged.
//
// Enforcement: withStudioRoute({ feature }) on the feature's user routes, project creation for
// SLIDESHOW / LIBRARY_REFERENCE sources, and executeJob() for the feature's own jobs; all answer
// 403 `feature_disabled`. Staff admin routes (library ingestion etc.) are never gated, so staff can
// keep curating while a feature is off for users.

export const FEATURES = ['library', 'overlays', 'slideshow', 'image-library'] as const;
export type Feature = (typeof FEATURES)[number];

const ENV_VARS: Record<Feature, string> = {
  library: 'FEATURE_LIBRARY_ENABLED',
  overlays: 'FEATURE_OVERLAYS_ENABLED',
  slideshow: 'FEATURE_SLIDESHOW_ENABLED',
  'image-library': 'FEATURE_IMAGE_LIBRARY_ENABLED',
};

export const featureKeys = {
  global: (feature: Feature) => `studio.features.${feature}`,
  organisation: (feature: Feature, organisationId: string) =>
    `studio.features.${feature}.org.${organisationId}`,
} as const;

/** FEATURE_<NAME>_ENABLED: unset or "true" = on; "false" = off in this environment. */
export function featureEnabledByEnv(
  feature: Feature,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[ENV_VARS[feature]]?.trim().toLowerCase();
  if (!raw || raw === 'true') return true;
  if (raw === 'false') return false;
  logger.warn({ variable: ENV_VARS[feature], value: raw }, '[features] invalid value; feature off');
  return false;
}

/** 'true'/absent = on, 'false' = off, anything else fails closed (off). */
function flagAllows(key: string, value: string | undefined): boolean {
  if (value === undefined || value === FLAG_ON) return true;
  if (value !== FLAG_OFF)
    logger.warn({ key, value }, '[features] unrecognised flag; failing closed');
  return false;
}

export type FeatureStatus =
  { enabled: true } | { enabled: false; scope: 'environment' | 'global' | 'organisation' };

export interface FeatureGate {
  status(feature: Feature, organisationId: string): Promise<FeatureStatus>;
  assertEnabled(feature: Feature, organisationId: string): Promise<void>;
  invalidate(): void;
}

export function createFeatureGate(deps: {
  store: FlagStore;
  env?: Record<string, string | undefined>;
  now?: () => number;
  ttlMs?: number;
}): FeatureGate {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? KILL_SWITCH_CACHE_TTL_MS;
  const cache = new Map<string, { value: string | undefined; expiresAt: number }>();

  async function read(keys: string[]): Promise<Map<string, string | undefined>> {
    const out = new Map<string, string | undefined>();
    const stale = keys.filter((key) => {
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) {
        out.set(key, hit.value);
        return false;
      }
      return true;
    });
    if (stale.length > 0) {
      const fetched = await deps.store.getFlags(stale);
      const expiresAt = now() + ttlMs;
      for (const key of stale) {
        cache.set(key, { value: fetched.get(key), expiresAt });
        out.set(key, fetched.get(key));
      }
    }
    return out;
  }

  async function status(feature: Feature, organisationId: string): Promise<FeatureStatus> {
    if (!featureEnabledByEnv(feature, deps.env)) return { enabled: false, scope: 'environment' };
    const globalKey = featureKeys.global(feature);
    const orgKey = featureKeys.organisation(feature, organisationId);
    const values = await read([globalKey, orgKey]);
    if (!flagAllows(globalKey, values.get(globalKey))) return { enabled: false, scope: 'global' };
    if (!flagAllows(orgKey, values.get(orgKey))) return { enabled: false, scope: 'organisation' };
    return { enabled: true };
  }

  return {
    status,
    async assertEnabled(feature, organisationId) {
      const result = await status(feature, organisationId);
      if (!result.enabled)
        throw new FeatureDisabledError(feature, `The ${feature} feature is currently disabled`, {
          scope: result.scope,
        });
    },
    invalidate() {
      cache.clear();
    },
  };
}

const gates = new WeakMap<object, FeatureGate>();

/** Process-wide gate for a Prisma client (one cache per client). */
export function featureGateFor(db: Pick<PrismaClient, 'systemFlag'>): FeatureGate {
  let gate = gates.get(db);
  if (!gate) {
    gate = createFeatureGate({ store: createPrismaFlagStore(db) });
    gates.set(db, gate);
  }
  return gate;
}

/** Project sources that belong to a switchable feature (A12.4). */
export function featureForProjectSource(sourceType: string): Feature | null {
  if (sourceType === 'SLIDESHOW') return 'slideshow';
  if (sourceType === 'LIBRARY_REFERENCE') return 'library';
  return null;
}

// ---------------------------------------------------------------- admin

export const setFeatureInput = z
  .object({
    feature: z.enum(FEATURES),
    scope: z.enum(['global', 'organisation']),
    organisationId: z.string().trim().min(1).max(128).optional(),
    enabled: z.boolean(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict()
  .refine((v) => v.scope === 'global' || Boolean(v.organisationId), {
    message: 'organisationId is required for scope "organisation"',
    path: ['organisationId'],
  })
  .refine((v) => v.scope === 'organisation' || v.organisationId === undefined, {
    message: 'organisationId is only allowed for scope "organisation"',
    path: ['organisationId'],
  });

export type SetFeatureInput = z.infer<typeof setFeatureInput>;

export interface FeatureState {
  global: boolean;
  environment: boolean;
  disabledFor: string[];
}

export async function featuresState(
  db: Pick<PrismaClient, 'systemFlag'>,
  env: Record<string, string | undefined> = process.env,
): Promise<{ features: Record<Feature, FeatureState>; propagationSec: number }> {
  const rows = await db.systemFlag.findMany({ where: { key: { startsWith: 'studio.features.' } } });
  const values = new Map(rows.map((r) => [r.key, r.value]));
  const entries = FEATURES.map((feature) => {
    const globalKey = featureKeys.global(feature);
    const prefix = featureKeys.organisation(feature, '');
    const disabledFor = rows
      .filter((r) => r.key.startsWith(prefix) && !flagAllows(r.key, r.value))
      .map((r) => r.key.slice(prefix.length))
      .sort();
    return [
      feature,
      {
        global: flagAllows(globalKey, values.get(globalKey)),
        environment: featureEnabledByEnv(feature, env),
        disabledFor,
      },
    ] as const;
  });
  return {
    features: Object.fromEntries(entries) as Record<Feature, FeatureState>,
    propagationSec: KILL_SWITCH_CACHE_TTL_MS / 1000,
  };
}

/**
 * PUT /admin/features. Enabling an organisation deletes its override (so the global value
 * applies); enabling globally writes 'true'.
 */
export async function setFeature(
  db: Pick<PrismaClient, 'systemFlag'>,
  input: SetFeatureInput,
): Promise<{ key: string; value: string | null }> {
  if (input.scope === 'organisation') {
    const key = featureKeys.organisation(input.feature, input.organisationId ?? '');
    if (input.enabled) {
      await db.systemFlag.deleteMany({ where: { key } });
      return { key, value: null };
    }
    await db.systemFlag.upsert({
      where: { key },
      create: { key, value: FLAG_OFF },
      update: { value: FLAG_OFF },
    });
    return { key, value: FLAG_OFF };
  }
  const key = featureKeys.global(input.feature);
  const value = input.enabled ? FLAG_ON : FLAG_OFF;
  await db.systemFlag.upsert({ where: { key }, create: { key, value }, update: { value } });
  return { key, value };
}
