import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { assetsBucket, getAssetStorage } from '../storage';
import { AnthropicAdapter } from './anthropic';
import { ElevenLabsAdapter } from './elevenlabs';
import type { ProviderAdapter } from './interface';
import { OpenAIAdapter } from './openai';
import { usdToGbpRateFromEnv } from './pricing';
import { createProviderRegistry, type ProviderRegistry } from './registry';
import { RunwayAdapter } from './runway';
import { ShotstackAdapter } from './shotstack';

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
        client: new Anthropic({ apiKey: anthropicKey }),
        model: envValue('ANTHROPIC_MODEL'),
        usdToGbpRate,
      }),
    );
  }

  const openaiKey = envValue('OPENAI_API_KEY');
  if (openaiKey) {
    adapters.push(
      new OpenAIAdapter({
        client: new OpenAI({ apiKey: openaiKey }),
        storage: getAssetStorage(),
        bucket: assetsBucket(),
        imageModel: envValue('OPENAI_IMAGE_MODEL'),
        usdToGbpRate,
      }),
    );
  }

  const runwayKey = envValue('RUNWAY_API_KEY');
  if (runwayKey) adapters.push(new RunwayAdapter({ apiKey: runwayKey, usdToGbpRate }));

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

  return adapters;
}

let registry: ProviderRegistry | undefined;

export function getProviderRegistry(): ProviderRegistry {
  registry ??= createProviderRegistry(buildAdaptersFromEnv());
  return registry;
}
