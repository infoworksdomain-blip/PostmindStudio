import { ConfigurationError } from '../../errors';
import { FAL_VIDEO_MODEL_KEYS, isFalVideoModelKey, type FalVideoModelKey } from './fal-models';

// BACKLOG 24.1 — fal.ai opt-in settings (providers/fal.ts, default-registry.ts, setup checker).

export const FAL_MODELS_ENV = 'STUDIO_FAL_VIDEO_MODELS';
export const FAL_KEY_ENV = 'FAL_KEY';

export type Env = Record<string, string | undefined>;

/**
 * STUDIO_FAL_VIDEO_MODELS: comma-separated model keys in preference order; empty = fal is off.
 * An unknown or repeated key is a ConfigurationError (a typo must not silently disable a model).
 */
export function parseFalVideoModels(raw: string | undefined): FalVideoModelKey[] {
  const keys = (raw ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '');
  const out: FalVideoModelKey[] = [];
  for (const key of keys) {
    if (!isFalVideoModelKey(key)) {
      throw new ConfigurationError(
        `${FAL_MODELS_ENV}: unknown fal model "${key}" (one of ${FAL_VIDEO_MODEL_KEYS.join(', ')})`,
      );
    }
    if (out.includes(key)) {
      throw new ConfigurationError(`${FAL_MODELS_ENV}: "${key}" is listed twice`);
    }
    out.push(key);
  }
  return out;
}

/**
 * The fal adapter's settings from env, or undefined when fal is off (no models listed). Models
 * listed without FAL_KEY is a ConfigurationError, so an opt-in never silently does nothing.
 */
export function falOptionsFromEnv(
  env: Env,
): { apiKey: string; models: FalVideoModelKey[] } | undefined {
  const models = parseFalVideoModels(env[FAL_MODELS_ENV]);
  if (models.length === 0) return undefined;
  const apiKey = env[FAL_KEY_ENV]?.trim();
  if (!apiKey) {
    throw new ConfigurationError(`${FAL_MODELS_ENV} is set but ${FAL_KEY_ENV} is empty`);
  }
  return { apiKey, models };
}
