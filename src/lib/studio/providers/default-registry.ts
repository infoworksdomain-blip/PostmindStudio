import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { ConfigurationError } from '../../errors';
import { logger } from '../../logger';
import { assetsBucket, getAssetStorage } from '../storage';
import { AnthropicAdapter } from './anthropic';
import { DEFAULT_MODEL } from './anthropic-models';
import { textModelsFromEnv } from './text-tasks';
import { ElevenLabsAdapter, wordTimingsFromEnv } from './elevenlabs';
import { ElevenLabsMusicAdapter } from './elevenlabs-music';
import type { ProviderAdapter } from './interface';
import type { ByocProviderId, ProviderKeyMap } from './byoc-providers';
import { OpenAIAdapter } from './openai';
import { usdToGbpRateFromEnv } from './pricing';
import { createProviderRegistry, type ProviderRegistry } from './registry';
import { AssemblyAiAdapter } from './assemblyai';
import { RunwayAdapter } from './runway';
import { LumaAdapter } from './luma';
import { veoOptionsFromEnv, VeoAdapter } from './veo';
import { seedanceOptionsFromEnv, SeedanceAdapter } from './seedance';
import { klingCredentialsFrom, klingOptionsFromEnv, KlingAdapter } from './kling';
import { HeyGenAdapter } from './heygen';
import { ShotstackAdapter } from './shotstack';
import { renderCallbackFromEnv } from './render-callback';
import { StoryblocksAudioAdapter } from './storyblocks-audio';
import { StoryblocksMusicAdapter } from './storyblocks-music';
import { StoryblocksVideoAdapter } from './storyblocks-video';
import { PexelsVideoAdapter } from './pexels-video';
import { PixabayVideoAdapter } from './pixabay-video';
import { stockCacheFromEnv } from '../images/stock-cache';
import { createBreakerRedisClient } from './circuit-breaker-redis';
import { redisConnectionFromEnv } from '../queue/redis';

// Explicit SDK timeouts (the SDK default is 10 minutes). OpenAI's image guide says complex
// prompts "may take up to 2 minutes", hence the longer OpenAI budget.
const ANTHROPIC_TIMEOUT_MS = 120_000;
const OPENAI_TIMEOUT_MS = 180_000;

// Builds the registry from environment. A provider is registered only when its API key is
// set, so an unconfigured provider is simply "not_configured" to the router.

type Env = Record<string, string | undefined>;

function valueOf(env: Env, name: string): string | undefined {
  const value = env[name];
  return value && value.trim() !== '' ? value : undefined;
}

/** The platform's own keys (the *_API_KEY variables) as a key map. */
export function providerKeysFromEnv(env: Env = process.env): ProviderKeyMap {
  const keys: ProviderKeyMap = {};
  const single: ReadonlyArray<[ByocProviderId, string]> = [
    ['anthropic', 'ANTHROPIC_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
    ['assemblyai', 'ASSEMBLYAI_API_KEY'],
    ['runway', 'RUNWAY_API_KEY'],
    ['luma', 'LUMA_API_KEY'],
    ['veo', 'GOOGLE_GEMINI_API_KEY'],
    ['seedance', 'BYTEPLUS_API_KEY'],
    ['heygen', 'HEYGEN_API_KEY'],
    ['elevenlabs', 'ELEVENLABS_API_KEY'],
    ['shotstack', 'SHOTSTACK_API_KEY'],
    ['pexels', 'PEXELS_API_KEY'],
  ];
  for (const [id, name] of single) {
    const apiKey = valueOf(env, name);
    if (apiKey) keys[id] = { apiKey };
  }
  const sbPublic = valueOf(env, 'STORYBLOCKS_API_PUBLIC_KEY');
  const sbPrivate = valueOf(env, 'STORYBLOCKS_API_PRIVATE_KEY');
  if (sbPublic && sbPrivate) keys.storyblocks = { apiKey: sbPublic, secondaryKey: sbPrivate };
  // 20.24: KLING_API_KEY, or the legacy KLING_ACCESS_KEY + KLING_SECRET_KEY pair (the access key
  // travels as apiKey and the secret as secondaryKey; half a pair is a ConfigurationError).
  const kling = klingCredentialsFrom({
    apiKey: valueOf(env, 'KLING_API_KEY'),
    accessKey: valueOf(env, 'KLING_ACCESS_KEY'),
    secretKey: valueOf(env, 'KLING_SECRET_KEY'),
  });
  if (kling?.kind === 'api_key') keys.kling = { apiKey: kling.apiKey };
  if (kling?.kind === 'access_key') {
    keys.kling = { apiKey: kling.accessKey, secondaryKey: kling.secretKey };
  }
  return keys;
}

export function buildAdaptersFromEnv(env: Env = process.env): ProviderAdapter[] {
  return buildAdaptersFromKeys(providerKeysFromEnv(env), env);
}

/**
 * P1 BYOC: builds adapters from a key map (the platform's env keys, or an organisation's own
 * keys). Non-secret settings (models, HeyGen avatar look, regions) still come from `env`.
 */
export function buildAdaptersFromKeys(
  keys: ProviderKeyMap,
  env: Env = process.env,
): ProviderAdapter[] {
  const envValue = (name: string) => valueOf(env, name);
  const usdToGbpRate = usdToGbpRateFromEnv();
  const adapters: ProviderAdapter[] = [];

  const anthropicKey = keys.anthropic?.apiKey;
  if (anthropicKey) {
    // 23.2: ANTHROPIC_MODEL for the planning tasks, ANTHROPIC_LIGHT_MODEL (Haiku 4.5 by default)
    // for the light ones, ANTHROPIC_TASK_MODELS per-task overrides (providers/text-tasks.ts).
    const models = textModelsFromEnv(env, DEFAULT_MODEL);
    adapters.push(
      new AnthropicAdapter({
        client: new Anthropic({ apiKey: anthropicKey, timeout: ANTHROPIC_TIMEOUT_MS }),
        model: models.standard,
        lightModel: models.light,
        taskModels: models.overrides,
        usdToGbpRate,
      }),
    );
  }

  const openaiKey = keys.openai?.apiKey;
  if (openaiKey) {
    adapters.push(
      new OpenAIAdapter({
        client: new OpenAI({ apiKey: openaiKey, timeout: OPENAI_TIMEOUT_MS }),
        storage: getAssetStorage(),
        bucket: assetsBucket(),
        imageModel: envValue('OPENAI_IMAGE_MODEL'),
        // 15.C1: the Layers 1–2 text fallback and the captions transcription fallback.
        textModel: envValue('OPENAI_TEXT_MODEL'),
        usdToGbpRate,
      }),
    );
  }

  const assemblyKey = keys.assemblyai?.apiKey;
  if (assemblyKey) {
    adapters.push(
      new AssemblyAiAdapter({
        apiKey: assemblyKey,
        usdToGbpRate,
        region: envValue('ASSEMBLYAI_REGION') === 'eu' ? 'eu' : 'us',
      }),
    );
  }

  const runwayKey = keys.runway?.apiKey;
  if (runwayKey) adapters.push(new RunwayAdapter({ apiKey: runwayKey, usdToGbpRate }));

  // BACKLOG 13.32: Luma is the AI_CLIP fallback for Runway (router.ts candidate lists).
  const lumaKey = keys.luma?.apiKey;
  if (lumaKey) adapters.push(new LumaAdapter({ apiKey: lumaKey, usdToGbpRate }));

  // BACKLOG 20.20: Google Veo 3.1 (Gemini API), the AI_CLIP fallback after Seedance and Kling (router.ts,
  // order since 20.23). VEO_MODEL / VEO_PERSON_GENERATION are optional (veo.ts defaults).
  const veoKey = keys.veo?.apiKey;
  if (veoKey) {
    adapters.push(new VeoAdapter({ apiKey: veoKey, usdToGbpRate, ...veoOptionsFromEnv(env) }));
  }

  // BACKLOG 20.23: BytePlus ModelArk Seedance — the first AI_CLIP option on every tier
  // (router.ts). SEEDANCE_MODEL, SEEDANCE_FULL_MODEL (21.3), SEEDANCE_LONG_MODEL and
  // BYTEPLUS_ARK_BASE_URL are optional (seedance.ts defaults). A full-model refusal that falls
  // back to Mini is logged for the operator (the account alert fires only if Mini fails too).
  const seedanceKey = keys.seedance?.apiKey;
  if (seedanceKey) {
    adapters.push(
      new SeedanceAdapter({
        apiKey: seedanceKey,
        usdToGbpRate,
        ...seedanceOptionsFromEnv(env),
        onFullModelFallback: (event) =>
          logger.warn(
            { providerId: 'seedance', ...event },
            'Seedance full model refused; using the default model (activate or top up in ModelArk)',
          ),
      }),
    );
  }

  // BACKLOG 20.24: Kling 3.0 (Kling AI API key). KLING_MODEL / KLING_RESOLUTION /
  // KLING_BASE_URL are optional (kling.ts defaults); router.ts sets its place in the order. A
  // secondary key means the legacy AccessKey (apiKey) + SecretKey (secondaryKey) JWT pair.
  const klingKey = keys.kling?.apiKey;
  if (klingKey) {
    const klingSecret = keys.kling?.secondaryKey;
    const credentials = klingSecret
      ? { kind: 'access_key' as const, accessKey: klingKey, secretKey: klingSecret }
      : { kind: 'api_key' as const, apiKey: klingKey };
    adapters.push(new KlingAdapter({ credentials, usdToGbpRate, ...klingOptionsFromEnv(env) }));
  }

  // HeyGen renders AI_AVATAR shots with a stock (or brand) avatar look. Registering it makes
  // Layer 2 offer AI_AVATAR, so a key without an avatar is a configuration error, not a skip.
  const heygenKey = keys.heygen?.apiKey;
  if (heygenKey) {
    const defaultAvatarId = envValue('HEYGEN_AVATAR_ID');
    if (!defaultAvatarId) {
      throw new ConfigurationError(
        'HEYGEN_AVATAR_ID must be set with HEYGEN_API_KEY (an avatar look id from GET /v3/avatars/looks)',
      );
    }
    adapters.push(new HeyGenAdapter({ apiKey: heygenKey, defaultAvatarId, usdToGbpRate }));
  }

  const elevenKey = keys.elevenlabs?.apiKey;
  if (elevenKey) {
    adapters.push(
      new ElevenLabsAdapter({
        apiKey: elevenKey,
        storage: getAssetStorage(),
        bucket: assetsBucket(),
        model: envValue('ELEVENLABS_MODEL'),
        // 23.2: narration with character timings (captions without transcription).
        wordTimings: wordTimingsFromEnv(env),
        usdToGbpRate,
      }),
    );
    // Layer 5 music uses the same ElevenLabs key (the Music API needs a paid plan). A separate
    // provider id so it has its own breaker, kill switch and cost lines.
    adapters.push(
      new ElevenLabsMusicAdapter({
        apiKey: elevenKey,
        storage: getAssetStorage(),
        bucket: assetsBucket(),
        model: envValue('ELEVENLABS_MUSIC_MODEL'),
        usdToGbpRate,
      }),
    );
  }

  const shotstackKey = keys.shotstack?.apiKey;
  if (shotstackKey) {
    // 23.1: render callbacks only on the platform account (the callback route checks a render's
    // status with the platform key; a BYOC organisation's renders keep polling).
    const callback =
      shotstackKey === envValue('SHOTSTACK_API_KEY') ? renderCallbackFromEnv(env) : undefined;
    adapters.push(
      new ShotstackAdapter({
        apiKey: shotstackKey,
        environment: envValue('SHOTSTACK_ENVIRONMENT') ?? 'stage',
        usdToGbpRate,
        ...(callback && { callback }),
      }),
    );
  }

  // 13.27 sound effects: the same Storyblocks keys as the stock image source.
  const storyblocksPublic = keys.storyblocks?.apiKey;
  const storyblocksPrivate = keys.storyblocks?.secondaryKey;
  if (storyblocksPublic && storyblocksPrivate) {
    adapters.push(
      new StoryblocksAudioAdapter({
        publicKey: storyblocksPublic,
        privateKey: storyblocksPrivate,
        storage: getAssetStorage(),
        bucket: assetsBucket(),
      }),
    );
    // 15.C2: the Layer 5 music library fallback (same keys, content_type=music).
    adapters.push(
      new StoryblocksMusicAdapter({
        publicKey: storyblocksPublic,
        privateKey: storyblocksPrivate,
        storage: getAssetStorage(),
        bucket: assetsBucket(),
      }),
    );
    // Phase 15 (13.38 correction): STOCK_FOOTAGE shots. Registering it makes Layer 2 offer
    // the STOCK_FOOTAGE treatment (pipeline/scripting.ts availableTreatments).
    adapters.push(
      new StoryblocksVideoAdapter({ publicKey: storyblocksPublic, privateKey: storyblocksPrivate }),
    );
  }

  // Phase 15 (13.38 correction): STOCK_FOOTAGE fallback, the key the stock image source uses.
  const pexelsKey = keys.pexels?.apiKey;
  if (pexelsKey) adapters.push(new PexelsVideoAdapter({ apiKey: pexelsKey }));
  // 22.2: Pixabay videos, the platform's free PIXABAY_API_KEY (the key Pixabay images use), with
  // the shared 24 h stock search cache Pixabay's terms require.
  const pixabayKey = envValue('PIXABAY_API_KEY')?.trim();
  if (pixabayKey)
    adapters.push(
      new PixabayVideoAdapter({
        apiKey: pixabayKey,
        cache: stockCacheFromEnv(
          env,
          () => createBreakerRedisClient(redisConnectionFromEnv()),
          logger,
        ),
      }),
    );

  return adapters;
}

let registry: ProviderRegistry | undefined;

export function getProviderRegistry(): ProviderRegistry {
  registry ??= createProviderRegistry(buildAdaptersFromEnv());
  return registry;
}
