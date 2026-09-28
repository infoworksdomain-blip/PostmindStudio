import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError, PlatformError } from '../../errors';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import {
  createLinkedInOAuth,
  createTikTokOAuth,
  createXOAuth,
  createYouTubeOAuth,
  oauthClientFromEnv,
  pkcePair,
  type OAuthConfig,
} from './oauth';

const config: OAuthConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://app.example/callback',
};

function deps(fetchImpl: typeof fetch, now = () => 1_000_000) {
  return { fetchImpl, now };
}

describe('pkcePair', () => {
  it('derives an S256 challenge from the verifier deterministically', () => {
    const pair = pkcePair();
    expect(pair.verifier).toMatch(/^[\w-]+$/);
    expect(pair.challenge).toMatch(/^[\w-]+$/);
    expect(pair.challenge).not.toBe(pair.verifier);
  });

  it('produces a fresh verifier every call', () => {
    const a = pkcePair();
    const b = pkcePair();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe('createTikTokOAuth', () => {
  it('builds the authorize URL with client_key, scopes and state', () => {
    const client = createTikTokOAuth(config, deps(fetch));
    const url = new URL(client.authorizeUrl({ state: 'state-1' }));
    expect(url.origin + url.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(url.searchParams.get('client_key')).toBe('client-id');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('scope')).toBe(
      'user.info.basic,video.publish,video.upload,video.list',
    );
    expect(client.usesPkce).toBe(false);
  });

  it('exchanges a code for a token set using comma-separated scopes', async () => {
    const { fetch: fetchImpl, requests } = fakeFetch(
      json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'a,b' }),
    );
    const client = createTikTokOAuth(config, deps(fetchImpl));
    const tokens = await client.exchangeCode({ code: 'code-1' });
    expect(tokens).toEqual({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: new Date(1_000_000 + 3600 * 1000),
      scopes: ['a', 'b'],
    });
    const body = requests[0]?.body as URLSearchParams;
    expect(body.get('client_key')).toBe('client-id');
    expect(body.get('client_secret')).toBe('client-secret');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('code-1');
  });

  it('refreshes a token', async () => {
    const { fetch: fetchImpl, requests } = fakeFetch(json({ access_token: 'at-2', scope: '' }));
    const client = createTikTokOAuth(config, deps(fetchImpl));
    const tokens = await client.refresh('rt-old');
    expect(tokens.accessToken).toBe('at-2');
    expect(tokens.scopes).toEqual([]);
    const body = requests[0]?.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt-old');
  });

  it('fetches the connected account from user/info', async () => {
    const { fetch: fetchImpl, requests } = fakeFetch(
      json({ data: { user: { open_id: 'open-1', display_name: 'Alice' } } }),
    );
    const client = createTikTokOAuth(config, deps(fetchImpl));
    const account = await client.fetchAccount('at-1');
    expect(account).toEqual({ id: 'open-1', name: 'Alice' });
    expect(requests[0]?.headers.authorization).toBe('Bearer at-1');
  });

  it('throws PlatformError when user/info has no open_id', async () => {
    const { fetch: fetchImpl } = fakeFetch(json({ data: {} }));
    const client = createTikTokOAuth(config, deps(fetchImpl));
    await expect(client.fetchAccount('at-1')).rejects.toBeInstanceOf(PlatformError);
  });

  it('maps a token response with no access_token to needs_reconnect', async () => {
    const { fetch: fetchImpl } = fakeFetch(json({ error: 'invalid_grant' }));
    const client = createTikTokOAuth(config, deps(fetchImpl));
    await expect(client.exchangeCode({ code: 'bad' })).rejects.toMatchObject({
      errorClass: 'needs_reconnect',
      retryable: false,
    });
  });

  it('maps a 400 token-endpoint failure to needs_reconnect via refine', async () => {
    const { fetch: fetchImpl } = fakeFetch(
      json({ error: 'invalid_grant', error_description: 'expired' }, 400),
    );
    const client = createTikTokOAuth(config, deps(fetchImpl));
    await expect(client.refresh('expired-token')).rejects.toMatchObject({
      errorClass: 'needs_reconnect',
      retryable: false,
      message: 'expired',
    });
  });

  it('does not reclassify a 429 as needs_reconnect', async () => {
    const { fetch: fetchImpl } = fakeFetch(json({ error: 'rate_limited' }, 429));
    const client = createTikTokOAuth(config, deps(fetchImpl));
    await expect(client.refresh('rt')).rejects.toMatchObject({ errorClass: 'rate_limited' });
  });

  it('does not reclassify a 500 as needs_reconnect', async () => {
    const { fetch: fetchImpl } = fakeFetch(json({ error: 'server_error' }, 500));
    const client = createTikTokOAuth(config, deps(fetchImpl));
    await expect(client.refresh('rt')).rejects.toMatchObject({ errorClass: 'unavailable' });
  });
});

describe('createYouTubeOAuth', () => {
  it('builds the authorize URL requesting offline access and forced consent', () => {
    const client = createYouTubeOAuth(config, deps(fetch));
    const url = new URL(client.authorizeUrl({ state: 'state-2' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly',
    );
    expect(client.usesPkce).toBe(false);
  });

  it('exchanges a code using space-separated scopes', async () => {
    const { fetch: fetchImpl, requests } = fakeFetch(
      json({ access_token: 'at', refresh_token: 'rt', expires_in: 60, scope: 'a b c' }),
    );
    const client = createYouTubeOAuth(config, deps(fetchImpl));
    const tokens = await client.exchangeCode({ code: 'c1' });
    expect(tokens.scopes).toEqual(['a', 'b', 'c']);
    expect(requests[0]?.url).toBe('https://oauth2.googleapis.com/token');
  });

  it('refreshes a token', async () => {
    const { fetch: fetchImpl, requests } = fakeFetch(json({ access_token: 'at2', scope: '' }));
    const client = createYouTubeOAuth(config, deps(fetchImpl));
    await client.refresh('rt');
    const body = requests[0]?.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
  });

  it('fetches the account from the channels endpoint', async () => {
    const { fetch: fetchImpl } = fakeFetch(
      json({ items: [{ id: 'chan-1', snippet: { title: 'My Channel' } }] }),
    );
    const client = createYouTubeOAuth(config, deps(fetchImpl));
    const account = await client.fetchAccount('at');
    expect(account).toEqual({ id: 'chan-1', name: 'My Channel' });
  });

  it('throws invalid_request PlatformError when the Google account has no channel', async () => {
    const { fetch: fetchImpl } = fakeFetch(json({ items: [] }));
    const client = createYouTubeOAuth(config, deps(fetchImpl));
    await expect(client.fetchAccount('at')).rejects.toMatchObject({
      errorClass: 'invalid_request',
      retryable: false,
    });
  });
});

describe('createXOAuth', () => {
  it('requires a PKCE code challenge to build the authorize URL', () => {
    const client = createXOAuth(config, deps(fetch));
    expect(() => client.authorizeUrl({ state: 's' })).toThrow(ConfigurationError);
  });

  it('builds the authorize URL with S256 PKCE params when a challenge is given', () => {
    const client = createXOAuth(config, deps(fetch));
    const url = new URL(client.authorizeUrl({ state: 's1', codeChallenge: 'challenge-1' }));
    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe(
      'tweet.read tweet.write users.read media.write offline.access',
    );
    expect(client.usesPkce).toBe(true);
  });

  it('requires a PKCE code verifier to exchange a code', async () => {
    const client = createXOAuth(config, deps(fetch));
    await expect(client.exchangeCode({ code: 'c1' })).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('exchanges a code using HTTP Basic client authentication', async () => {
    const { fetch: fetchImpl, requests } = fakeFetch(
      json({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 60,
        scope: 'tweet.read tweet.write',
      }),
    );
    const client = createXOAuth(config, deps(fetchImpl));
    const tokens = await client.exchangeCode({ code: 'c1', codeVerifier: 'verifier-1' });
    expect(tokens.scopes).toEqual(['tweet.read', 'tweet.write']);
    const expectedBasic = `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`;
    expect(requests[0]?.headers.authorization).toBe(expectedBasic);
    const body = requests[0]?.body as URLSearchParams;
    expect(body.get('code_verifier')).toBe('verifier-1');
    expect(body.get('client_id')).toBe('client-id');
  });

  it('refreshes with Basic auth and client_id in the body', async () => {
    const { fetch: fetchImpl, requests } = fakeFetch(json({ access_token: 'at2', scope: '' }));
    const client = createXOAuth(config, deps(fetchImpl));
    await client.refresh('rt-1');
    const expectedBasic = `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`;
    expect(requests[0]?.headers.authorization).toBe(expectedBasic);
    const body = requests[0]?.body as URLSearchParams;
    expect(body.get('refresh_token')).toBe('rt-1');
    expect(body.get('grant_type')).toBe('refresh_token');
  });

  it('fetches the account and prefers the @username as name', async () => {
    const { fetch: fetchImpl } = fakeFetch(
      json({ data: { id: 'u1', name: 'Alice', username: 'alice' } }),
    );
    const client = createXOAuth(config, deps(fetchImpl));
    const account = await client.fetchAccount('at');
    expect(account).toEqual({ id: 'u1', name: '@alice' });
  });

  it('falls back to name then id when no username is present', async () => {
    const { fetch: fetchImpl } = fakeFetch(json({ data: { id: 'u1', name: 'Alice' } }));
    const client = createXOAuth(config, deps(fetchImpl));
    expect(await client.fetchAccount('at')).toEqual({ id: 'u1', name: 'Alice' });
  });

  it('throws PlatformError when users/me returns no id', async () => {
    const { fetch: fetchImpl } = fakeFetch(json({ data: {} }));
    const client = createXOAuth(config, deps(fetchImpl));
    await expect(client.fetchAccount('at')).rejects.toBeInstanceOf(PlatformError);
  });
});

describe('createLinkedInOAuth', () => {
  it('builds the authorize URL with openid scopes', () => {
    const client = createLinkedInOAuth(config, deps(fetch));
    const url = new URL(client.authorizeUrl({ state: 's1' }));
    expect(url.origin + url.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(url.searchParams.get('scope')).toBe('openid profile w_member_social');
    expect(client.usesPkce).toBe(false);
  });

  it('exchanges a code, splitting scopes on commas and whitespace', async () => {
    const { fetch: fetchImpl, requests } = fakeFetch(
      json({ access_token: 'at', expires_in: 100, scope: 'openid, profile' }),
    );
    const client = createLinkedInOAuth(config, deps(fetchImpl));
    const tokens = await client.exchangeCode({ code: 'c1' });
    expect(tokens.scopes).toEqual(['openid', 'profile']);
    expect(requests[0]?.url).toBe('https://www.linkedin.com/oauth/v2/accessToken');
  });

  it('refreshes a token when the org is an approved partner', async () => {
    const { fetch: fetchImpl, requests } = fakeFetch(json({ access_token: 'at2', scope: '' }));
    const client = createLinkedInOAuth(config, deps(fetchImpl));
    await client.refresh('rt-1');
    const body = requests[0]?.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_secret')).toBe('client-secret');
  });

  it('fetches the account and prefixes the member URN', async () => {
    const { fetch: fetchImpl } = fakeFetch(json({ sub: 'member-1', name: 'Bob' }));
    const client = createLinkedInOAuth(config, deps(fetchImpl));
    const account = await client.fetchAccount('at');
    expect(account).toEqual({ id: 'urn:li:person:member-1', name: 'Bob' });
  });

  it('throws PlatformError when userinfo returns no sub', async () => {
    const { fetch: fetchImpl } = fakeFetch(json({}));
    const client = createLinkedInOAuth(config, deps(fetchImpl));
    await expect(client.fetchAccount('at')).rejects.toBeInstanceOf(PlatformError);
  });
});

describe('oauthClientFromEnv', () => {
  const ENV_KEYS = [
    'TIKTOK_CLIENT_KEY',
    'TIKTOK_CLIENT_SECRET',
    'TIKTOK_REDIRECT_URI',
    'YOUTUBE_CLIENT_ID',
    'YOUTUBE_CLIENT_SECRET',
    'YOUTUBE_REDIRECT_URI',
    'X_CLIENT_ID',
    'X_CLIENT_SECRET',
    'X_REDIRECT_URI',
    'LINKEDIN_CLIENT_ID',
    'LINKEDIN_CLIENT_SECRET',
    'LINKEDIN_REDIRECT_URI',
  ] as const;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    vi.restoreAllMocks();
  });

  it('builds a TikTok client from env vars', () => {
    process.env.TIKTOK_CLIENT_KEY = 'k';
    process.env.TIKTOK_CLIENT_SECRET = 's';
    process.env.TIKTOK_REDIRECT_URI = 'https://app.example/tiktok';
    const client = oauthClientFromEnv('tiktok');
    expect(client.platform).toBe('tiktok');
    expect(client.authorizeUrl({ state: 'x' })).toContain('client_key=k');
  });

  it('builds a YouTube client from env vars', () => {
    process.env.YOUTUBE_CLIENT_ID = 'k';
    process.env.YOUTUBE_CLIENT_SECRET = 's';
    process.env.YOUTUBE_REDIRECT_URI = 'https://app.example/youtube';
    expect(oauthClientFromEnv('youtube').platform).toBe('youtube');
  });

  it('builds an X client from env vars', () => {
    process.env.X_CLIENT_ID = 'k';
    process.env.X_CLIENT_SECRET = 's';
    process.env.X_REDIRECT_URI = 'https://app.example/x';
    expect(oauthClientFromEnv('x').platform).toBe('x');
  });

  it('builds a LinkedIn client from env vars', () => {
    process.env.LINKEDIN_CLIENT_ID = 'k';
    process.env.LINKEDIN_CLIENT_SECRET = 's';
    process.env.LINKEDIN_REDIRECT_URI = 'https://app.example/linkedin';
    expect(oauthClientFromEnv('linkedin').platform).toBe('linkedin');
  });

  it('throws ConfigurationError when a required env var is missing', () => {
    process.env.TIKTOK_CLIENT_KEY = 'k';
    // TIKTOK_CLIENT_SECRET and TIKTOK_REDIRECT_URI left unset.
    expect(() => oauthClientFromEnv('tiktok')).toThrow(ConfigurationError);
  });
});
