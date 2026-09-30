import { ConfigurationError } from '../../errors';

// BACKLOG 20.6 — which Hive API the platform's content-safety check calls, from env. Pure, so
// the worker (default-registry.ts, create-deps.ts), the staging gate and the go-live settings
// checker (src/lib/setup/env-file.ts) all read the same rule.
//
//   HIVE_API_VERSION   v2 | v3. Unset: v3 when only HIVE_V3_SECRET_KEY is set, otherwise v2
//                      (an Enterprise V2 key wins when both are present).
//   HIVE_API_KEY       V2 (Enterprise project) API key — "Integration & API Keys" on the project.
//   HIVE_V3_SECRET_KEY V3 (self-serve) key — the "Secret Key" column of Hive's "API Keys (V3)"
//                      dialog. Hive: "Your Secret Key is your API Key"; the "Access Key ID" next
//                      to it is only an identifier and is not sent
//                      (https://docs.thehive.ai/docs/visual-moderation-playground, read 2026-09-30).
//   HIVE_V3_MAX_FRAMES frames sampled from a render longer than V3's 60 s video limit (1-60,
//                      default 10). Each frame is one V3 request; see hive-v3.ts.

export type HiveApiVersion = 'v2' | 'v3';

export const HIVE_V2_KEY_ENV = 'HIVE_API_KEY';
export const HIVE_V3_KEY_ENV = 'HIVE_V3_SECRET_KEY';
export const HIVE_VERSION_ENV = 'HIVE_API_VERSION';
export const HIVE_V3_MAX_FRAMES_ENV = 'HIVE_V3_MAX_FRAMES';

/** Default frames per long render: 10 requests of V3's default 100 requests/day. */
export const DEFAULT_HIVE_V3_MAX_FRAMES = 10;
/** Upper bound: a long render never costs more V3 requests than a 60 s video has frames. */
export const MAX_HIVE_V3_MAX_FRAMES = 60;

type Env = Record<string, string | undefined>;

const valueOf = (env: Env, name: string) => env[name]?.trim() ?? '';

/** The Hive API in use. Throws on a HIVE_API_VERSION other than v2 / v3 / empty. */
export function resolveHiveApiVersion(env: Env): HiveApiVersion {
  const explicit = valueOf(env, HIVE_VERSION_ENV).toLowerCase();
  if (explicit === 'v2' || explicit === 'v3') return explicit;
  if (explicit !== '') throw new ConfigurationError(`${HIVE_VERSION_ENV} must be v2 or v3`);
  return valueOf(env, HIVE_V3_KEY_ENV) !== '' && valueOf(env, HIVE_V2_KEY_ENV) === '' ? 'v3' : 'v2';
}

/** The env var holding the key for a version. */
export function hiveKeyEnv(version: HiveApiVersion): string {
  return version === 'v3' ? HIVE_V3_KEY_ENV : HIVE_V2_KEY_ENV;
}

/** The key for the resolved version, or undefined when that version's key is not set. */
export function hiveKeyFromEnv(env: Env): { version: HiveApiVersion; apiKey?: string } {
  const version = resolveHiveApiVersion(env);
  const apiKey = valueOf(env, hiveKeyEnv(version));
  return apiKey ? { version, apiKey } : { version };
}

/** HIVE_V3_MAX_FRAMES: whole number 1-60, default 10. */
export function parseHiveV3MaxFrames(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_HIVE_V3_MAX_FRAMES;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_HIVE_V3_MAX_FRAMES) {
    throw new ConfigurationError(
      `${HIVE_V3_MAX_FRAMES_ENV} must be a whole number from 1 to ${MAX_HIVE_V3_MAX_FRAMES}`,
    );
  }
  return n;
}
