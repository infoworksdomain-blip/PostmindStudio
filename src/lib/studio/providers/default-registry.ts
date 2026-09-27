import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { ConfigurationError } from '../../errors';
import { assetsBucket, getAssetStorage } from '../storage';
import { AnthropicAdapter } from './anthropic';
import { ElevenLabsAdapter } from './elevenlabs';
import { ElevenLabsMusicAdapter } from './elevenlabs-music';
import { HiveAdapter } from './hive';
import type { ProviderAdapter } from './interface';
import { OpenAIAdapter } from './openai';
import { usdToGbpRateFromEnv } from './pricing';
import { createProviderRegistry, type ProviderRegistry } from './registry';
import { AssemblyAiAdapter } from './assemblyai';
import { RunwayAdapter } from './runway';
import { LumaAdapter } from './luma';
import { HeyGenAdapter } from './heygen';
import { ShotstackAdapter } from './shotstack';
import { StoryblocksAudioAdapter } from './storyblocks-audio';
import { createHiveResultReader } from './hive-results';

// Explicit SDK timeouts (the SDK default is 10 minutes). OpenAI's image guide says complex
// prompts "may take up to 2 minutes", hence the longer OpenAI budget.
const ANTHROPIC_TIMEOUT_MS = 120_000;
const OPENAI_TIMEOUT_MS = 180_000;

// Builds the registry from environment. A provider is registered only when its API key is
// set, so an unconfigured provider is simply "not_configured" to the router.

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== '' ? value : undefined;
}

export function buildAdaptersFromEnv(): ProviderAdapter[] {
  const usdToGbpRate = usdToGbpRateFromEnv();
  const adapters: ProviderAdapter[] = [];

  const anthropicKey = envValue('ANTHROPIC_API_KEY');
  if (anthropicKey) {
    adapters.push(
      new AnthropicAdapter({
        client: new Anthropic({ apiKey: anthropicKey, timeout: ANTHROPIC_TIMEOUT_MS }),
        model: envValue('ANTHROPIC_MODEL'),
        usdToGbpRate,
      }),
    );
  }

  const openaiKey = envValue('OPENAI_API_KEY');
  if (openaiKey) {
    adapters.push(
      new OpenAIAdapter({
        client: new OpenAI({ apiKey: openaiKey, timeout: OPENAI_TIMEOUT_MS }),
        storage: getAssetStorage(),
        bucket: assetsBucket(),
        imageModel: envValue('OPENAI_IMAGE_MODEL'),
        usdToGbpRate,
      }),
    );
  }

  const assemblyKey = envValue('ASSEMBLYAI_API_KEY');
  if (assemblyKey) {
    adapters.push(
      new AssemblyAiAdapter({
        apiKey: assemblyKey,
        usdToGbpRate,
        region: envValue('ASSEMBLYAI_REGION') === 'eu' ? 'eu' : 'us',
      }),
    );
  }

  const runwayKey = envValue('RUNWAY_API_KEY');
  if (runwayKey) adapters.push(new RunwayAdapter({ apiKey: runwayKey, usdToGbpRate }));

  // BACKLOG 13.32: Luma is the AI_CLIP fallback for Runway (router.ts candidate lists).
  const lumaKey = envValue('LUMA_API_KEY');
  if (lumaKey) adapters.push(new LumaAdapter({ apiKey: lumaKey, usdToGbpRate }));

  // HeyGen renders AI_AVATAR shots with a stock (or brand) avatar look. Registering it makes
  // Layer 2 offer AI_AVATAR, so a key without an avatar is a configuration error, not a skip.
  const heygenKey = envValue('HEYGEN_API_KEY');
  if (heygenKey) {
    const defaultAvatarId = envValue('HEYGEN_AVATAR_ID');
    if (!defaultAvatarId) {
      throw new ConfigurationError(
        'HEYGEN_AVATAR_ID must be set with HEYGEN_API_KEY (an avatar look id from GET /v3/avatars/looks)',
      );
    }
    adapters.push(new HeyGenAdapter({ apiKey: heygenKey, defaultAvatarId, usdToGbpRate }));
  }

  const elevenKey = envValue('ELEVENLABS_API_KEY');
  if (elevenKey) {
    adapters.push(
      new ElevenLabsAdapter({
        apiKey: elevenKey,
        storage: getAssetStorage(),
        bucket: assetsBucket(),
        model: envValue('ELEVENLABS_MODEL'),
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

  const shotstackKey = envValue('SHOTSTACK_API_KEY');
  if (shotstackKey) {
    adapters.push(
      new ShotstackAdapter({
        apiKey: shotstackKey,
        environment: envValue('SHOTSTACK_ENVIRONMENT') ?? 'stage',
      }),
    );
  }

  const hiveKey = envValue('HIVE_API_KEY');
  if (hiveKey) {
    adapters.push(
      new HiveAdapter({
        apiKey: hiveKey,
        usdToGbpRate,
        // 13.25: async callbacks are stored by POST /api/studio/webhooks/hive.
        asyncResults: createHiveResultReader(async () => (await import('../../prisma')).prisma),
      }),
    );
  }

  // 13.27 sound effects: the same Storyblocks keys as the stock image source.
  const storyblocksPublic = envValue('STORYBLOCKS_API_PUBLIC_KEY');
  const storyblocksPrivate = envValue('STORYBLOCKS_API_PRIVATE_KEY');
  if (storyblocksPublic && storyblocksPrivate) {
    adapters.push(
      new StoryblocksAudioAdapter({
        publicKey: storyblocksPublic,
        privateKey: storyblocksPrivate,
        storage: getAssetStorage(),
        bucket: assetsBucket(),
      }),
    );
  }

  return adapters;
}

let registry: ProviderRegistry | undefined;

export function getProviderRegistry(): ProviderRegistry {
  registry ??= createProviderRegistry(buildAdaptersFromEnv());
  return registry;
}
