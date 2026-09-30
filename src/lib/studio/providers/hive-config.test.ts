import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../errors';
import {
  DEFAULT_HIVE_V3_MAX_FRAMES,
  hiveKeyFromEnv,
  parseHiveV3MaxFrames,
  resolveHiveApiVersion,
} from './hive-config';

// 20.6 — which Hive API the platform uses.

describe('resolveHiveApiVersion', () => {
  it.each([
    [{}, 'v2'],
    [{ HIVE_API_KEY: 'k2' }, 'v2'],
    [{ HIVE_V3_SECRET_KEY: 'k3' }, 'v3'],
    [{ HIVE_V3_SECRET_KEY: 'k3', HIVE_API_KEY: '  ' }, 'v3'],
    // Both keys and no explicit choice: the Enterprise V2 key wins.
    [{ HIVE_API_KEY: 'k2', HIVE_V3_SECRET_KEY: 'k3' }, 'v2'],
    [{ HIVE_API_VERSION: 'v3', HIVE_API_KEY: 'k2', HIVE_V3_SECRET_KEY: 'k3' }, 'v3'],
    [{ HIVE_API_VERSION: ' V2 ', HIVE_V3_SECRET_KEY: 'k3' }, 'v2'],
  ] as const)('%j → %s', (env, version) => {
    expect(resolveHiveApiVersion(env)).toBe(version);
  });

  it('rejects anything but v2 / v3', () => {
    expect(() => resolveHiveApiVersion({ HIVE_API_VERSION: 'v4' })).toThrow(ConfigurationError);
  });
});

describe('hiveKeyFromEnv', () => {
  it('returns the key of the selected version only', () => {
    expect(hiveKeyFromEnv({ HIVE_V3_SECRET_KEY: ' k3 ' })).toEqual({ version: 'v3', apiKey: 'k3' });
    expect(hiveKeyFromEnv({ HIVE_API_KEY: 'k2' })).toEqual({ version: 'v2', apiKey: 'k2' });
    // Explicit v3 with only a V2 key: no key (not silently the wrong one).
    expect(hiveKeyFromEnv({ HIVE_API_VERSION: 'v3', HIVE_API_KEY: 'k2' })).toEqual({
      version: 'v3',
    });
  });
});

describe('parseHiveV3MaxFrames', () => {
  it('defaults to 10 and accepts 1-60', () => {
    expect(parseHiveV3MaxFrames(undefined)).toBe(DEFAULT_HIVE_V3_MAX_FRAMES);
    expect(parseHiveV3MaxFrames(' ')).toBe(10);
    expect(parseHiveV3MaxFrames('1')).toBe(1);
    expect(parseHiveV3MaxFrames('60')).toBe(60);
  });

  it.each(['0', '61', '2.5', 'many'])('rejects %s', (raw) => {
    expect(() => parseHiveV3MaxFrames(raw)).toThrow('HIVE_V3_MAX_FRAMES');
  });
});
