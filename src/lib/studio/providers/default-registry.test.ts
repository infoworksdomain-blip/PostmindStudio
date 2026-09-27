import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from '../../errors';
import { buildAdaptersFromEnv } from './default-registry';

const KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'RUNWAY_API_KEY',
  'LUMA_API_KEY',
  'HEYGEN_API_KEY',
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
  vi.stubEnv('HEYGEN_AVATAR_ID', '');
  for (const key of KEYS) vi.stubEnv(key, '');
});

afterEach(() => vi.unstubAllEnvs());

describe('buildAdaptersFromEnv', () => {
  it('registers nothing without credentials', () => {
    expect(buildAdaptersFromEnv()).toEqual([]);
  });

  it('registers exactly the providers whose keys are set', () => {
    for (const key of KEYS) vi.stubEnv(key, 'test-key');
    vi.stubEnv('HEYGEN_AVATAR_ID', 'stock-look');
    expect(buildAdaptersFromEnv().map((a) => a.providerId)).toEqual([
      'anthropic',
      'openai',
      'runway',
      'luma',
      'heygen',
      'elevenlabs',
      'elevenlabs-music',
      'shotstack',
      'hive',
    ]);
  });

  it('requires a HeyGen avatar look with the HeyGen key', () => {
    vi.stubEnv('HEYGEN_API_KEY', 'k');
    expect(() => buildAdaptersFromEnv()).toThrow(/HEYGEN_AVATAR_ID/);
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
