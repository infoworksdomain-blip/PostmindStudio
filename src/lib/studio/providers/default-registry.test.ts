import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from '../../errors';
import { VeoAdapter } from './veo';
import { SeedanceAdapter } from './seedance';
import {
  buildAdaptersFromEnv,
  buildAdaptersFromKeys,
  providerKeysFromEnv,
} from './default-registry';

const KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'RUNWAY_API_KEY',
  'LUMA_API_KEY',
  'GOOGLE_GEMINI_API_KEY',
  'BYTEPLUS_API_KEY',
  'HEYGEN_API_KEY',
  'ELEVENLABS_API_KEY',
  'SHOTSTACK_API_KEY',
  'STORYBLOCKS_API_PUBLIC_KEY',
  'STORYBLOCKS_API_PRIVATE_KEY',
  'PEXELS_API_KEY',
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
  vi.stubEnv('OPENAI_TEXT_MODEL', '');
  vi.stubEnv('VEO_MODEL', '');
  vi.stubEnv('VEO_PERSON_GENERATION', '');
  for (const key of ['SEEDANCE_MODEL', 'SEEDANCE_LONG_MODEL', 'BYTEPLUS_ARK_BASE_URL'])
    vi.stubEnv(key, '');
  for (const key of KEYS) vi.stubEnv(key, '');
  for (const key of [
    'HIVE_API_KEY',
    'HIVE_API_VERSION',
    'HIVE_V3_SECRET_KEY',
    'HIVE_V3_MAX_FRAMES',
  ])
    vi.stubEnv(key, '');
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
      'veo',
      'seedance',
      'heygen',
      'elevenlabs',
      'elevenlabs-music',
      'shotstack',
      'storyblocks-audio',
      'storyblocks-music',
      'storyblocks-video',
      'pexels-video',
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
    vi.stubEnv('SHOTSTACK_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'k');
    vi.stubEnv('OPENAI_TEXT_MODEL', 'gpt-3.5-turbo');
    expect(() => buildAdaptersFromEnv()).toThrow(/No pricing configured for OpenAI text model/);
  });
});

// P1 BYOC: an organisation's own keys build the same adapters as the platform's env keys.
describe('buildAdaptersFromKeys', () => {
  it('builds adapters from a key map, one key backing several adapters', () => {
    const ids = buildAdaptersFromKeys({
      runway: { apiKey: 'org-runway' },
      elevenlabs: { apiKey: 'org-eleven' },
      storyblocks: { apiKey: 'pub', secondaryKey: 'priv' },
    }).map((a) => a.providerId);
    expect(ids).toEqual([
      'runway',
      'elevenlabs',
      'elevenlabs-music',
      'storyblocks-audio',
      'storyblocks-music',
      'storyblocks-video',
    ]);
  });

  it('skips a two-part key without its private half', () => {
    expect(buildAdaptersFromKeys({ storyblocks: { apiKey: 'pub' } })).toEqual([]);
  });

  it('reads the platform keys from env', () => {
    vi.stubEnv('RUNWAY_API_KEY', 'rk');
    vi.stubEnv('STORYBLOCKS_API_PUBLIC_KEY', 'pub');
    expect(providerKeysFromEnv()).toEqual({ runway: { apiKey: 'rk' } });
    vi.stubEnv('STORYBLOCKS_API_PRIVATE_KEY', 'priv');
    expect(providerKeysFromEnv().storyblocks).toEqual({ apiKey: 'pub', secondaryKey: 'priv' });
  });
});

describe('no Hive (20.21)', () => {
  it('registers no content-safety adapter, even with the old Hive keys set', () => {
    vi.stubEnv('HIVE_API_KEY', 'old-v2-key');
    vi.stubEnv('HIVE_V3_SECRET_KEY', 'dummy-v3-secret');
    vi.stubEnv('HIVE_API_VERSION', 'v9');
    expect(buildAdaptersFromEnv()).toEqual([]);
    expect(providerKeysFromEnv()).toEqual({});
  });
});

describe('Google Veo (20.20)', () => {
  it('registers Veo from GOOGLE_GEMINI_API_KEY with the documented defaults', () => {
    vi.stubEnv('GOOGLE_GEMINI_API_KEY', 'test-key');
    const [veo] = buildAdaptersFromEnv();
    expect(veo).toBeInstanceOf(VeoAdapter);
    expect((veo as VeoAdapter).model).toBe('veo-3.1-fast-generate-preview');
    expect(providerKeysFromEnv().veo).toEqual({ apiKey: 'test-key' });
  });

  it('uses VEO_MODEL, and refuses a model without a price row', () => {
    vi.stubEnv('GOOGLE_GEMINI_API_KEY', 'test-key');
    vi.stubEnv('VEO_MODEL', 'veo-3.1-lite-generate-preview');
    expect((buildAdaptersFromEnv()[0] as VeoAdapter).model).toBe('veo-3.1-lite-generate-preview');
    vi.stubEnv('VEO_MODEL', 'veo-9-ultra');
    expect(() => buildAdaptersFromEnv()).toThrow(ConfigurationError);
  });

  it('an organisation key (BYOC) builds Veo too', () => {
    expect(buildAdaptersFromKeys({ veo: { apiKey: 'org-key' } }).map((a) => a.providerId)).toEqual([
      'veo',
    ]);
  });
});

describe('BytePlus Seedance (20.23)', () => {
  it('registers Seedance from BYTEPLUS_API_KEY with the documented defaults', () => {
    vi.stubEnv('BYTEPLUS_API_KEY', 'test.key');
    const [seedance] = buildAdaptersFromEnv();
    expect(seedance).toBeInstanceOf(SeedanceAdapter);
    expect(seedance).toMatchObject({
      providerId: 'seedance',
      model: 'dreamina-seedance-2-0-mini-260615',
      longModel: 'dreamina-seedance-2-5-260628',
      baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    });
    expect(providerKeysFromEnv().seedance).toEqual({ apiKey: 'test.key' });
  });

  it('uses SEEDANCE_MODEL / SEEDANCE_LONG_MODEL / BYTEPLUS_ARK_BASE_URL and refuses unknown values', () => {
    vi.stubEnv('BYTEPLUS_API_KEY', 'test.key');
    vi.stubEnv('SEEDANCE_MODEL', 'dreamina-seedance-2-0-fast-260128');
    vi.stubEnv('SEEDANCE_LONG_MODEL', 'dreamina-seedance-2-5-260628');
    vi.stubEnv('BYTEPLUS_ARK_BASE_URL', 'https://ark.eu-west.bytepluses.com/api/v3');
    expect(buildAdaptersFromEnv()[0]).toMatchObject({
      model: 'dreamina-seedance-2-0-fast-260128',
      baseUrl: 'https://ark.eu-west.bytepluses.com/api/v3',
    });
    vi.stubEnv('SEEDANCE_MODEL', 'seedance-1-5-pro-251215');
    expect(() => buildAdaptersFromEnv()).toThrow(ConfigurationError);
  });

  it('an organisation key (BYOC) builds Seedance too', () => {
    expect(
      buildAdaptersFromKeys({ seedance: { apiKey: 'org-key' } }).map((a) => a.providerId),
    ).toEqual(['seedance']);
  });
});
