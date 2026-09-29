import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigurationError, PlatformError } from '../../errors';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import {
  appSecretProof,
  createMetaOAuth,
  metaConnectConfigured,
  metaGraphVersion,
  metaOAuthFromEnv,
  metaRedirectUri,
  toAssets,
} from './meta-oauth';

// Phase 18 §2.10 — Studio's Facebook Login for Business client against a mocked Graph API.

const CONFIG = {
  appId: '1234567890',
  appSecret: 'test-app-secret',
  configId: '9876543210',
  redirectUri: 'https://studio.test/api/studio/platform-connections/oauth-callback',
  graphVersion: 'v26.0',
};
const NOW = Date.UTC(2026, 9, 1);

const proof = (token: string) => createHmac('sha256', CONFIG.appSecret).update(token).digest('hex');

describe('appSecretProof', () => {
  it('is the hex HMAC-SHA256 of the token keyed with the app secret', () => {
    expect(appSecretProof('EAAB-token', CONFIG.appSecret)).toBe(proof('EAAB-token'));
    expect(appSecretProof('EAAB-token', CONFIG.appSecret)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('createMetaOAuth', () => {
  it('builds the FLfB dialog URL with config_id, code response and the state', () => {
    const { fetch } = fakeFetch();
    const url = new URL(
      createMetaOAuth(CONFIG, { fetchImpl: fetch, now: () => NOW }).authorizeUrl({
        state: 'st-1',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CONFIG.appId,
      redirect_uri: CONFIG.redirectUri,
      state: 'st-1',
      response_type: 'code',
      config_id: CONFIG.configId,
    });
  });

  it('exchanges the code, then for a long-lived token, server side with the secret', async () => {
    const { fetch, requests } = fakeFetch(
      json({ access_token: 'short', token_type: 'bearer', expires_in: 3600 }),
      json({ access_token: 'long', token_type: 'bearer', expires_in: 5_183_944 }),
    );
    const client = createMetaOAuth(CONFIG, { fetchImpl: fetch, now: () => NOW });
    const short = await client.exchangeCode('the-code');
    const long = await client.exchangeLongLived(short.accessToken);
    expect(short).toEqual({ accessToken: 'short', expiresAt: new Date(NOW + 3_600_000) });
    expect(long.accessToken).toBe('long');
    const first = new URL(requests[0]!.url);
    expect(first.pathname).toBe('/v26.0/oauth/access_token');
    expect(Object.fromEntries(first.searchParams)).toEqual({
      client_id: CONFIG.appId,
      redirect_uri: CONFIG.redirectUri,
      client_secret: CONFIG.appSecret,
      code: 'the-code',
    });
    const second = new URL(requests[1]!.url);
    expect(Object.fromEntries(second.searchParams)).toEqual({
      grant_type: 'fb_exchange_token',
      client_id: CONFIG.appId,
      client_secret: CONFIG.appSecret,
      fb_exchange_token: 'short',
    });
  });

  it('refuses a token response without a token', async () => {
    const { fetch } = fakeFetch(json({ error: { message: 'bad' } }));
    const client = createMetaOAuth(CONFIG, { fetchImpl: fetch, now: () => NOW });
    await expect(client.exchangeCode('x')).rejects.toBeInstanceOf(PlatformError);
  });

  it('maps a Graph 400 on the code exchange to a PlatformError', async () => {
    const { fetch } = fakeFetch(
      json({ error: { message: 'Invalid verification code', code: 100 } }, 400),
    );
    const client = createMetaOAuth(CONFIG, { fetchImpl: fetch, now: () => NOW });
    await expect(client.exchangeCode('x')).rejects.toMatchObject({ platform: 'facebook' });
  });

  it('sends appsecret_proof on every user-token Graph call', async () => {
    const { fetch, requests } = fakeFetch(
      json({ id: '10001', name: 'Ann' }),
      json({
        data: [
          { permission: 'pages_manage_posts', status: 'granted' },
          { permission: 'instagram_content_publish', status: 'granted' },
          { permission: 'read_insights', status: 'declined' },
        ],
      }),
    );
    const client = createMetaOAuth(CONFIG, { fetchImpl: fetch, now: () => NOW });
    expect(await client.fetchUser('long')).toEqual({ id: '10001', name: 'Ann' });
    expect(await client.fetchGrantedScopes('long')).toEqual([
      'pages_manage_posts',
      'instagram_content_publish',
    ]);
    for (const request of requests) {
      const url = new URL(request.url);
      expect(url.searchParams.get('access_token')).toBe('long');
      expect(url.searchParams.get('appsecret_proof')).toBe(proof('long'));
    }
    expect(new URL(requests[0]!.url).searchParams.get('fields')).toBe('id,name');
  });

  it('rejects a /me without a numeric user id', async () => {
    const { fetch } = fakeFetch(json({ name: 'no id' }));
    const client = createMetaOAuth(CONFIG, { fetchImpl: fetch, now: () => NOW });
    await expect(client.fetchUser('long')).rejects.toBeInstanceOf(PlatformError);
  });

  it('lists Pages and linked IG accounts, following Graph paging with a fresh proof', async () => {
    const next = 'https://graph.facebook.com/v26.0/10001/accounts?access_token=long&after=abc';
    const { fetch, requests } = fakeFetch(
      json({
        data: [
          {
            id: '201',
            name: 'Leeds Sourdough',
            access_token: 'page-201',
            tasks: ['ANALYZE', 'CREATE_CONTENT', 'MANAGE'],
            instagram_business_account: { id: '17841400000000001', username: 'leedssourdough' },
          },
        ],
        paging: { next },
      }),
      json({ data: [{ id: '202', name: 'Market stall', access_token: 'page-202' }] }),
    );
    const client = createMetaOAuth(CONFIG, { fetchImpl: fetch, now: () => NOW });
    const { assets, skippedPages } = await client.fetchAssets('long');
    expect(skippedPages).toBe(0);
    expect(assets).toEqual([
      {
        platform: 'facebook',
        accountId: '201',
        accountName: 'Leeds Sourdough',
        accessToken: 'page-201',
        pageId: '201',
      },
      {
        platform: 'instagram',
        accountId: '17841400000000001',
        accountName: '@leedssourdough',
        accessToken: 'page-201',
        pageId: '201',
      },
      {
        platform: 'facebook',
        accountId: '202',
        accountName: 'Market stall',
        accessToken: 'page-202',
        pageId: '202',
      },
    ]);
    const first = new URL(requests[0]!.url);
    expect(first.pathname).toBe('/v26.0/me/accounts');
    expect(first.searchParams.get('fields')).toBe(
      'id,name,access_token,tasks,instagram_business_account{id,username,name}',
    );
    expect(new URL(requests[1]!.url).searchParams.get('appsecret_proof')).toBe(proof('long'));
    expect(new URL(requests[1]!.url).searchParams.get('after')).toBe('abc');
  });

  it('never follows a paging link to another host', async () => {
    const { fetch, requests } = fakeFetch(
      json({
        data: [{ id: '201', name: 'P', access_token: 'page-201' }],
        paging: { next: 'https://evil.example/steal?access_token=long' },
      }),
    );
    const client = createMetaOAuth(CONFIG, { fetchImpl: fetch, now: () => NOW });
    const { assets } = await client.fetchAssets('long');
    expect(assets).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });
});

describe('toAssets', () => {
  it('skips Pages without a token, with a non-numeric id, or without CREATE_CONTENT', () => {
    const result = toAssets([
      { id: '1', name: 'No token' },
      { id: 'abc', name: 'Bad id', access_token: 't' },
      { id: '2', name: 'Analyst only', access_token: 't', tasks: ['ANALYZE'] },
      {
        id: '3',
        name: 'OK',
        access_token: 't3',
        instagram_business_account: { id: 'not-numeric' },
      },
    ]);
    expect(result.skippedPages).toBe(3);
    expect(result.assets).toEqual([
      { platform: 'facebook', accountId: '3', accountName: 'OK', accessToken: 't3', pageId: '3' },
    ]);
  });

  it('names an IG account by its name when it has no username', () => {
    const { assets } = toAssets([
      { id: '3', access_token: 't', instagram_business_account: { id: '44', name: 'Cafe' } },
    ]);
    expect(assets.map((a) => a.accountName)).toEqual(['3', 'Cafe']);
  });
});

describe('env helpers', () => {
  const env = {
    META_APP_ID: '1',
    META_APP_SECRET: 's',
    META_LOGIN_CONFIG_ID: '2',
    APP_URL: 'https://studio.example.com/',
  };

  it('derives the redirect URI from APP_URL unless META_REDIRECT_URI is set', () => {
    expect(metaRedirectUri(env)).toBe(
      'https://studio.example.com/api/studio/platform-connections/oauth-callback',
    );
    expect(metaRedirectUri({ ...env, META_REDIRECT_URI: 'https://x.test/cb' })).toBe(
      'https://x.test/cb',
    );
    expect(metaRedirectUri({})).toBeUndefined();
  });

  it('is configured only with app id, secret, config id and an origin', () => {
    expect(metaConnectConfigured(env)).toBe(true);
    expect(metaConnectConfigured({ ...env, META_LOGIN_CONFIG_ID: ' ' })).toBe(false);
    expect(() => metaOAuthFromEnv({ ...env, META_APP_SECRET: '' })).toThrow(ConfigurationError);
    expect(metaOAuthFromEnv(env).graphVersion).toBe('v26.0');
  });

  it('prefers META_GRAPH_VERSION, then META_GRAPH_API_VERSION', () => {
    expect(metaGraphVersion({ META_GRAPH_VERSION: 'v27.0', META_GRAPH_API_VERSION: 'v25.0' })).toBe(
      'v27.0',
    );
    expect(metaGraphVersion({ META_GRAPH_API_VERSION: 'v25.0' })).toBe('v25.0');
    expect(metaGraphVersion({})).toBe('v26.0');
  });
});
