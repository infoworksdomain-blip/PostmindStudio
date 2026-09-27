import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from '../../errors';
import { buildAdaptersFromEnv } from './default-registry';

const KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'RUNWAY_API_KEY',
  'ELEVENLABS_API_KEY',
  'SHOTSTACK_API_KEY',
  'HIVE_API_KEY',
];

beforeEach(() => {
  vi.stubEnv('STUDIO_USD_TO_GBP_RATE', '0.75');
  vi.stubEnv('AWS_REGION', 'eu-west-2');
  vi.stubEnv('S3_BUCKET_ASSETS', 'studio-assets-dev');
  vi.stubEnv('ANTHROPIC_MODEL', '');
  vi.stubEnv('ELEVENLABS_MODEL', '');
  vi.stubEnv('ELEVENLABS_MUSIC_MODEL', '');
  vi.stubEnv('SHOTSTACK_ENVIRONMENT', '');
  for (const key of KEYS) vi.stubEnv(key, '');
});

afterEach(() => vi.unstubAllEnvs());

describe('buildAdaptersFromEnv', () => {
  it('registers nothing without credentials', () => {
    expect(buildAdaptersFromEnv()).toEqual([]);
  });

  it('registers exactly the providers whose keys are set', () => {
    for (const key of KEYS) vi.stubEnv(key, 'test-key');
    expect(buildAdaptersFromEnv().map((a) => a.providerId)).toEqual([
      'anthropic',
      'openai',
      'runway',
      'elevenlabs',
      'elevenlabs-music',
      'shotstack',
      'hive',
    ]);
  });

  it('rejects an unknown ElevenLabs music model', () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'k');
    vi.stubEnv('ELEVENLABS_MUSIC_MODEL', 'suno_v4');
    expect(() => buildAdaptersFromEnv()).toThrow(/Unsupported ElevenLabs music model/);
  });

  it('requires the FX rate', () => {
    vi.stubEnv('STUDIO_USD_TO_GBP_RATE', '');
    expect(() => buildAdaptersFromEnv()).toThrow(ConfigurationError);
  });

  it('surfaces bad model / environment configuration', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k');
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-3-opus');
    expect(() => buildAdaptersFromEnv()).toThrow(/No pricing configured/);
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('SHOTSTACK_API_KEY', 'k');
    vi.stubEnv('SHOTSTACK_ENVIRONMENT', 'production');
    expect(() => buildAdaptersFromEnv()).toThrow(/SHOTSTACK_ENVIRONMENT/);
  });
});
