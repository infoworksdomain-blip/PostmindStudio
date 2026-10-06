import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../errors';
import {
  RENDER_CALLBACK_PATH,
  renderCallbackFromEnv,
  renderCallbackUrl,
  verifyRenderCallbackToken,
} from './render-callback';

const SECRET = 'x'.repeat(40);
const HTTPS = { APP_URL: 'https://studio.example.com', STUDIO_RENDER_CALLBACK_SECRET: SECRET };

function tokenOf(url: string) {
  const parsed = new URL(url);
  return { n: parsed.searchParams.get('n'), s: parsed.searchParams.get('s'), parsed };
}

describe('renderCallbackFromEnv (23.1)', () => {
  it('is on for an https APP_URL with a secret', () => {
    const config = renderCallbackFromEnv(HTTPS);
    expect(config?.baseUrl).toBe('https://studio.example.com');
  });

  it('is off when APP_URL is not https, missing or invalid', () => {
    expect(renderCallbackFromEnv({ ...HTTPS, APP_URL: 'http://localhost:3010' })).toBeUndefined();
    expect(renderCallbackFromEnv({ STUDIO_RENDER_CALLBACK_SECRET: SECRET })).toBeUndefined();
    expect(renderCallbackFromEnv({ ...HTTPS, APP_URL: 'not a url' })).toBeUndefined();
  });

  it('is off when switched off or without any secret', () => {
    expect(renderCallbackFromEnv({ ...HTTPS, STUDIO_RENDER_CALLBACKS: 'off' })).toBeUndefined();
    expect(renderCallbackFromEnv({ APP_URL: 'https://studio.example.com' })).toBeUndefined();
  });

  it('derives a distinct secret from BETTER_AUTH_SECRET when no own secret is set', () => {
    const auth = 'a'.repeat(48);
    const config = renderCallbackFromEnv({
      APP_URL: 'https://studio.example.com',
      BETTER_AUTH_SECRET: auth,
    });
    expect(config).toBeDefined();
    expect(config?.secret.equals(Buffer.from(auth))).toBe(false);
    expect(config?.secret).toHaveLength(32);
  });

  it('refuses a short own secret at start', () => {
    expect(() =>
      renderCallbackFromEnv({ ...HTTPS, STUDIO_RENDER_CALLBACK_SECRET: 'short' }),
    ).toThrow(ConfigurationError);
  });
});

describe('render callback token (23.1)', () => {
  const config = renderCallbackFromEnv(HTTPS)!;

  it('builds a per-render URL on the callback route that verifies', () => {
    const first = tokenOf(renderCallbackUrl(config));
    const second = tokenOf(renderCallbackUrl(config));
    expect(first.parsed.origin + first.parsed.pathname).toBe(
      `https://studio.example.com${RENDER_CALLBACK_PATH}`,
    );
    expect(first.n).not.toBe(second.n);
    expect(verifyRenderCallbackToken(config.secret, first.n, first.s)).toBe(true);
  });

  it('refuses a token signed with another secret, a swapped nonce or a malformed value', () => {
    const { n, s } = tokenOf(renderCallbackUrl(config));
    const other = renderCallbackFromEnv({
      ...HTTPS,
      STUDIO_RENDER_CALLBACK_SECRET: 'y'.repeat(40),
    })!;
    expect(verifyRenderCallbackToken(other.secret, n, s)).toBe(false);
    const { n: otherNonce } = tokenOf(renderCallbackUrl(config));
    expect(verifyRenderCallbackToken(config.secret, otherNonce, s)).toBe(false);
    expect(verifyRenderCallbackToken(config.secret, null, s)).toBe(false);
    expect(verifyRenderCallbackToken(config.secret, n, null)).toBe(false);
    expect(verifyRenderCallbackToken(config.secret, n, `${s}A`)).toBe(false);
    expect(verifyRenderCallbackToken(config.secret, 'short', s)).toBe(false);
  });
});
