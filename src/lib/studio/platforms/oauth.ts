import { createHash, randomBytes } from 'node:crypto';
import { requireEnv } from '../../env';
import { ConfigurationError, PlatformError } from '../../errors';
import { platformRequest } from './http';

// BACKLOG 5.8 — OAuth 2.0 for the platforms Studio connects itself (spec 7.12: TikTok, YouTube,
// X, LinkedIn; Meta reuses Engagement). Endpoints and parameters from each platform's current
// docs (read 2026-09-27):
//   TikTok   https://www.tiktok.com/v2/auth/authorize/ · POST open.tiktokapis.com/v2/oauth/token/
//            (client_key, client_secret, code, grant_type, redirect_uri) · GET /v2/user/info/
//   YouTube  https://accounts.google.com/o/oauth2/v2/auth (access_type=offline) ·
//            POST https://oauth2.googleapis.com/token · GET youtube/v3/channels?part=snippet&mine=true
//   X        https://x.com/i/oauth2/authorize (PKCE) · POST https://api.x.com/2/oauth2/token
//            (Basic client auth) · GET https://api.x.com/2/users/me
//   LinkedIn https://www.linkedin.com/oauth/v2/authorization · POST /oauth/v2/accessToken ·
//            GET https://api.linkedin.com/v2/userinfo

export type OAuthPlatform = 'tiktok' | 'youtube' | 'x' | 'linkedin';
export const OAUTH_PLATFORMS: OAuthPlatform[] = ['tiktok', 'youtube', 'x', 'linkedin'];

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
}

export interface ConnectedAccount {
  id: string;
  name: string;
}

export interface OAuthClient {
  readonly platform: OAuthPlatform;
  readonly usesPkce: boolean;
  authorizeUrl(input: { state: string; codeChallenge?: string }): string;
  exchangeCode(input: { code: string; codeVerifier?: string }): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  fetchAccount(accessToken: string): Promise<ConnectedAccount>;
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** RFC 7636 S256: base64url(sha256(verifier)). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

interface RawToken {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

function toTokenSet(
  platform: OAuthPlatform,
  raw: RawToken,
  now: number,
  scopeSeparator: string | RegExp,
): TokenSet {
  if (!raw.access_token) {
    throw new PlatformError(
      platform,
      'needs_reconnect',
      `Token response had no access_token (${raw.error ?? 'unknown'})`,
      false,
    );
  }
  return {
    accessToken: raw.access_token,
    ...(raw.refresh_token && { refreshToken: raw.refresh_token }),
    ...(raw.expires_in && { expiresAt: new Date(now + raw.expires_in * 1000) }),
    scopes: raw.scope ? raw.scope.split(scopeSeparator).filter(Boolean) : [],
  };
}

const describeOAuth = (body: unknown) => {
  const b = body as RawToken | undefined;
  return { message: b?.error_description ?? b?.error, code: b?.error };
};

/** Token endpoint failures on refresh mean the grant is gone: the user must reconnect. */
const refineOAuth = (status: number) =>
  status >= 400 && status < 500 && status !== 429
    ? { errorClass: 'needs_reconnect' as const, retryable: false }
    : undefined;

interface Deps {
  fetchImpl: typeof fetch;
  now: () => number;
}

function form(fields: Record<string, string | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) body.set(k, v);
  return body;
}

export function createTikTokOAuth(config: OAuthConfig, deps: Deps): OAuthClient {
  const tokenUrl = 'https://open.tiktokapis.com/v2/oauth/token/';
  const post = (fields: Record<string, string | undefined>) =>
    platformRequest<RawToken>(
      tokenUrl,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form(fields),
      },
      {
        platform: 'tiktok',
        fetchImpl: deps.fetchImpl,
        describe: describeOAuth,
        refine: refineOAuth,
      },
    );
  return {
    platform: 'tiktok',
    usesPkce: false,
    authorizeUrl({ state }) {
      const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
      url.searchParams.set('client_key', config.clientId);
      url.searchParams.set('scope', 'user.info.basic,video.publish');
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('state', state);
      return url.toString();
    },
    async exchangeCode({ code }) {
      const res = await post({
        client_key: config.clientId,
        client_secret: config.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: config.redirectUri,
      });
      return toTokenSet('tiktok', res.body, deps.now(), ',');
    },
    async refresh(refreshToken) {
      const res = await post({
        client_key: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
      return toTokenSet('tiktok', res.body, deps.now(), ',');
    },
    async fetchAccount(accessToken) {
      const res = await platformRequest<{
        data?: { user?: { open_id?: string; display_name?: string } };
      }>(
        'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name',
        { headers: { authorization: `Bearer ${accessToken}` } },
        { platform: 'tiktok', fetchImpl: deps.fetchImpl },
      );
      const user = res.body.data?.user;
      if (!user?.open_id)
        throw new PlatformError('tiktok', 'unknown', 'user/info returned no open_id', true);
      return { id: user.open_id, name: user.display_name ?? user.open_id };
    },
  };
}

export function createYouTubeOAuth(config: OAuthConfig, deps: Deps): OAuthClient {
  const post = (fields: Record<string, string | undefined>) =>
    platformRequest<RawToken>(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form(fields),
      },
      {
        platform: 'youtube',
        fetchImpl: deps.fetchImpl,
        describe: describeOAuth,
        refine: refineOAuth,
      },
    );
  return {
    platform: 'youtube',
    usesPkce: false,
    authorizeUrl({ state }) {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('response_type', 'code');
      // force-ssl covers videos.insert, videos.list and videos.delete (takedown).
      url.searchParams.set('scope', 'https://www.googleapis.com/auth/youtube.force-ssl');
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('include_granted_scopes', 'true');
      // A refresh token is only issued on first authorisation; consent re-issues it on reconnect.
      url.searchParams.set('prompt', 'consent');
      url.searchParams.set('state', state);
      return url.toString();
    },
    async exchangeCode({ code }) {
      const res = await post({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: config.redirectUri,
      });
      return toTokenSet('youtube', res.body, deps.now(), ' ');
    },
    async refresh(refreshToken) {
      const res = await post({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
      return toTokenSet('youtube', res.body, deps.now(), ' ');
    },
    async fetchAccount(accessToken) {
      const res = await platformRequest<{
        items?: Array<{ id?: string; snippet?: { title?: string } }>;
      }>(
        'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
        { headers: { authorization: `Bearer ${accessToken}` } },
        { platform: 'youtube', fetchImpl: deps.fetchImpl },
      );
      const channel = res.body.items?.[0];
      if (!channel?.id)
        throw new PlatformError(
          'youtube',
          'invalid_request',
          'This Google account has no YouTube channel',
          false,
        );
      return { id: channel.id, name: channel.snippet?.title ?? channel.id };
    },
  };
}

export function createXOAuth(config: OAuthConfig, deps: Deps): OAuthClient {
  const basic = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
  const post = (fields: Record<string, string | undefined>) =>
    platformRequest<RawToken>(
      'https://api.x.com/2/oauth2/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
        body: form(fields),
      },
      { platform: 'x', fetchImpl: deps.fetchImpl, describe: describeOAuth, refine: refineOAuth },
    );
  return {
    platform: 'x',
    usesPkce: true,
    authorizeUrl({ state, codeChallenge }) {
      if (!codeChallenge) throw new ConfigurationError('X OAuth requires a PKCE code challenge');
      const url = new URL('https://x.com/i/oauth2/authorize');
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('scope', 'tweet.read tweet.write users.read media.write offline.access');
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return url.toString();
    },
    async exchangeCode({ code, codeVerifier }) {
      if (!codeVerifier) throw new ConfigurationError('X OAuth requires the PKCE code verifier');
      const res = await post({
        code,
        grant_type: 'authorization_code',
        redirect_uri: config.redirectUri,
        code_verifier: codeVerifier,
        client_id: config.clientId,
      });
      return toTokenSet('x', res.body, deps.now(), ' ');
    },
    async refresh(refreshToken) {
      const res = await post({
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        client_id: config.clientId,
      });
      return toTokenSet('x', res.body, deps.now(), ' ');
    },
    async fetchAccount(accessToken) {
      const res = await platformRequest<{
        data?: { id?: string; name?: string; username?: string };
      }>(
        'https://api.x.com/2/users/me',
        { headers: { authorization: `Bearer ${accessToken}` } },
        { platform: 'x', fetchImpl: deps.fetchImpl },
      );
      const user = res.body.data;
      if (!user?.id) throw new PlatformError('x', 'unknown', 'users/me returned no id', true);
      return { id: user.id, name: user.username ? `@${user.username}` : (user.name ?? user.id) };
    },
  };
}

export function createLinkedInOAuth(config: OAuthConfig, deps: Deps): OAuthClient {
  const post = (fields: Record<string, string | undefined>) =>
    platformRequest<RawToken>(
      'https://www.linkedin.com/oauth/v2/accessToken',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form(fields),
      },
      {
        platform: 'linkedin',
        fetchImpl: deps.fetchImpl,
        describe: describeOAuth,
        refine: refineOAuth,
      },
    );
  return {
    platform: 'linkedin',
    usesPkce: false,
    authorizeUrl({ state }) {
      const url = new URL('https://www.linkedin.com/oauth/v2/authorization');
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('scope', 'openid profile w_member_social');
      url.searchParams.set('state', state);
      return url.toString();
    },
    async exchangeCode({ code }) {
      const res = await post({
        grant_type: 'authorization_code',
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
      });
      return toTokenSet('linkedin', res.body, deps.now(), /[\s,]+/);
    },
    async refresh(refreshToken) {
      // Programmatic refresh is only enabled for approved LinkedIn partners.
      const res = await post({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });
      return toTokenSet('linkedin', res.body, deps.now(), /[\s,]+/);
    },
    async fetchAccount(accessToken) {
      const res = await platformRequest<{ sub?: string; name?: string }>(
        'https://api.linkedin.com/v2/userinfo',
        { headers: { authorization: `Bearer ${accessToken}` } },
        { platform: 'linkedin', fetchImpl: deps.fetchImpl },
      );
      if (!res.body.sub)
        throw new PlatformError('linkedin', 'unknown', 'userinfo returned no sub', true);
      // Posts API authors are urn:li:person:{id}; LinkedIn's sign-in docs identify the member by `sub`.
      return { id: `urn:li:person:${res.body.sub}`, name: res.body.name ?? res.body.sub };
    },
  };
}

const ENV: Record<OAuthPlatform, [string, string, string]> = {
  tiktok: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REDIRECT_URI'],
  youtube: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REDIRECT_URI'],
  x: ['X_CLIENT_ID', 'X_CLIENT_SECRET', 'X_REDIRECT_URI'],
  linkedin: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'LINKEDIN_REDIRECT_URI'],
};

const FACTORIES: Record<OAuthPlatform, (c: OAuthConfig, d: Deps) => OAuthClient> = {
  tiktok: createTikTokOAuth,
  youtube: createYouTubeOAuth,
  x: createXOAuth,
  linkedin: createLinkedInOAuth,
};

export function oauthClientFromEnv(
  platform: OAuthPlatform,
  deps: Deps = { fetchImpl: fetch, now: Date.now },
): OAuthClient {
  const [id, secret, redirect] = ENV[platform];
  return FACTORIES[platform](
    {
      clientId: requireEnv(id),
      clientSecret: requireEnv(secret),
      redirectUri: requireEnv(redirect),
    },
    deps,
  );
}
