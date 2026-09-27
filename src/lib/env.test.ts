import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireEnv } from './env';
import { ConfigurationError } from './errors';

afterEach(() => vi.unstubAllEnvs());

describe('requireEnv', () => {
  it('returns the value when set', () => {
    vi.stubEnv('STUDIO_TEST_VAR', 'hello');
    expect(requireEnv('STUDIO_TEST_VAR')).toBe('hello');
  });

  it.each([undefined, '', '   '])('throws ConfigurationError for %o', (value) => {
    vi.stubEnv('STUDIO_TEST_VAR', value);
    expect(() => requireEnv('STUDIO_TEST_VAR')).toThrow(ConfigurationError);
  });
});
