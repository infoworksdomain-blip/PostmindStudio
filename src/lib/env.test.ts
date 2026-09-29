import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertStartupEnv, missingRequiredEnv, requireEnv, requiredEnvForModes } from './env';
import { ConfigurationError } from './errors';
import { studioModes } from './mode';

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

const secret = 'x'.repeat(32);
const standaloneEnv = {
  DATABASE_URL: 'postgresql://db',
  APP_URL: 'https://studio.example.com',
  BETTER_AUTH_SECRET: secret,
  STRIPE_SECRET_KEY: 'sk_test_1',
  STRIPE_WEBHOOK_SECRET: 'whsec_1',
  RESEND_API_KEY: 're_1',
  RESEND_WEBHOOK_SECRET: 'whsec_2',
  STUDIO_EMAIL_FROM: 'no-reply@example.com',
  STUDIO_UNSUBSCRIBE_SECRET: secret,
};

describe('requiredEnvForModes (Phase 18 §6)', () => {
  it('standalone needs the auth secret, Stripe and Resend but no PostMind Core keys', () => {
    const names = requiredEnvForModes(studioModes({})).map((k) => k.name);
    expect(names).toEqual(
      expect.arrayContaining(['BETTER_AUTH_SECRET', 'STRIPE_SECRET_KEY', 'RESEND_API_KEY']),
    );
    expect(names.some((n) => n.startsWith('POSTMIND_'))).toBe(false);
  });

  it('core needs PostMind Core and nothing from the standalone product', () => {
    const names = requiredEnvForModes(studioModes({ STUDIO_MODE: 'core' })).map((k) => k.name);
    expect(names).toEqual(
      expect.arrayContaining(['POSTMIND_JWKS_URL', 'POSTMIND_SERVICE_TOKEN', 'POSTMIND_AUDIT_URL']),
    );
    expect(names).not.toContain('BETTER_AUTH_SECRET');
    expect(names).not.toContain('STRIPE_SECRET_KEY');
    expect(new Set(names).size).toBe(names.length);
  });

  it('follows per-integration overrides', () => {
    const names = requiredEnvForModes(
      studioModes({
        STUDIO_BILLING: 'core',
        STUDIO_EMAIL_PROVIDER: 'none',
        STUDIO_AUDIT_SINK: 'both',
      }),
    ).map((k) => k.name);
    expect(names).not.toContain('STRIPE_SECRET_KEY');
    expect(names).not.toContain('RESEND_API_KEY');
    expect(names).toContain('POSTMIND_AUDIT_URL');
  });
});

describe('assertStartupEnv', () => {
  it('passes with the full standalone set', () => {
    expect(missingRequiredEnv(standaloneEnv)).toEqual([]);
    expect(() => assertStartupEnv(standaloneEnv)).not.toThrow();
  });

  it('lists every missing key and short secret at once', () => {
    const env = { ...standaloneEnv, BETTER_AUTH_SECRET: 'short', STRIPE_SECRET_KEY: '' };
    expect(missingRequiredEnv(env)).toEqual([
      'BETTER_AUTH_SECRET must be at least 32 characters',
      'STRIPE_SECRET_KEY is not set',
    ]);
    expect(() => assertStartupEnv(env)).toThrow(/STUDIO_MODE=standalone/);
  });

  it('refuses an unknown mode', () => {
    expect(() => assertStartupEnv({ ...standaloneEnv, STUDIO_MODE: 'both' })).toThrow(
      ConfigurationError,
    );
  });
});
