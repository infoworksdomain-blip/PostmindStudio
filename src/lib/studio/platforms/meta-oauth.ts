import { ConfigurationError, PlatformError } from '../../errors';
import { platformRequest } from './http';
import { DEFAULT_GRAPH_VERSION, GRAPH_HOST, graphErrors, graphProof } from './meta';

// Phase 18 §2.10 — Studio's own Facebook Login for Business (FLfB) flow, replacing the tokens
// PostMind Core used to push (STUDIO_META_CONNECT=studio). One login yields the user's Facebook
// Pages and the Instagram professional accounts linked to them. Sources (read 2026-09-29):
//   FLfB           https://developers.facebook.com/docs/facebook-login/facebook-login-for-business
//                  — a Business-type app; a "configuration" (User access token) holds the
//                  permissions and asset types; its Configuration ID replaces `scope` as
//                  `config_id` on the login dialog.
//   Manual flow    https://developers.facebook.com/documentation/facebook-login/guides/advanced/manual-flow
//                  GET https://www.facebook.com/{v}/dialog/oauth?client_id&redirect_uri&state
//                  [&response_type=code][&config_id]; cancel → ?error=access_denied&error_reason=
//                  user_denied; code exchange (server side) GET graph.facebook.com/{v}/oauth/
//                  access_token?client_id&redirect_uri&client_secret&code → {access_token,
//                  token_type, expires_in}. The docs describe no PKCE for this flow, so the
//                  single-use server-side `state` (oauth-state.ts) is the CSRF protection.
//   Long-lived     https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
//                  GET /oauth/access_token?grant_type=fb_exchange_token&client_id&client_secret&
//                  fb_exchange_token → ~60-day user token; GET /{user}/accounts with it returns
//                  Page tokens that "do not have an expiration date".
//   appsecret_proof https://developers.facebook.com/docs/graph-api/guides/secure-requests
//                  hex HMAC-SHA256 of the access token keyed with the app secret, sent on every
//                  call (required when the app enables "Require App Secret").
//   IG publishing  https://developers.facebook.com/docs/instagram-platform/content-publishing —
//                  "Instagram API with Facebook Login" uses a Facebook Page access token on
//                  graph.facebook.com, so an IG account is published with its Page's token.

export interface MetaOAuthConfig {
  appId: string;
  appSecret: string;
  /** Facebook Login for Business configuration id (App Dashboard → FLfB → Configurations). */
  configId: string;
  /** Must match a "Valid OAuth Redirect URI" exactly (and the one used on the dialog). */
  redirectUri: string;
  graphVersion: string;
}

export interface MetaToken {
  accessToken: string;
  expiresAt?: Date;
}

/** A Page or IG account the login granted, with the Page token that publishes to it. */
export interface MetaAsset {
  platform: 'facebook' | 'instagram';
  accountId: string;
  accountName: string;
  /** The Page's token (IG accounts are published with their linked Page's token). */
  accessToken: string;
  pageId: string;
}

export interface MetaOAuthClient {
  readonly graphVersion: string;
  authorizeUrl(input: { state: string }): string;
  exchangeCode(code: string): Promise<MetaToken>;
  exchangeLongLived(userToken: string): Promise<MetaToken>;
  /** The app-scoped user id (what deauthorise / data-deletion callbacks name). */
  fetchUser(userToken: string): Promise<{ id: string; name: string }>;
  /** Permissions the user granted (status=granted). */
  fetchGrantedScopes(userToken: string): Promise<string[]>;
  /** Pages the user can publish to, plus the IG professional accounts linked to them. */
  fetchAssets(userToken: string): Promise<{ assets: MetaAsset[]; skippedPages: number }>;
}

/** https://developers.facebook.com/docs/graph-api/guides/secure-requests#generate-the-proof */
export function appSecretProof(accessToken: string, appSecret: string): string {
  return graphProof(accessToken, appSecret);
}

interface Deps {
  fetchImpl: typeof fetch;
  now: () => number;
}

interface RawToken {
  access_token?: string;
  expires_in?: number;
}

interface RawPage {
  id?: string;
  name?: string;
  access_token?: string;
  tasks?: string[];
  instagram_business_account?: { id?: string; username?: string; name?: string };
}

interface RawAccounts {
  data?: RawPage[];
  paging?: { next?: string };
}

/** Pages are listed 100 at a time; stop following `next` after this many pages of results. */
const MAX_ACCOUNT_PAGES = 10;
const PAGE_FIELDS = 'id,name,access_token,tasks,instagram_business_account{id,username,name}';
const NUMERIC_ID = /^\d{1,64}$/;

export function createMetaOAuth(config: MetaOAuthConfig, deps: Deps): MetaOAuthClient {
  const base = `${GRAPH_HOST}/${config.graphVersion}`;

  const get = <T>(url: URL) =>
    platformRequest<T>(
      url.toString(),
      { method: 'GET' },
      {
        platform: 'facebook',
        fetchImpl: deps.fetchImpl,
        describe: graphErrors.describe,
        refine: graphErrors.refine,
      },
    );

  /** A Graph call with the user's token and its appsecret_proof. */
  const graph = <T>(path: string, token: string, params: Record<string, string> = {}) => {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('access_token', token);
    url.searchParams.set('appsecret_proof', appSecretProof(token, config.appSecret));
    return get<T>(url);
  };

  const toToken = (raw: RawToken, what: string): MetaToken => {
    if (!raw.access_token)
      throw new PlatformError('facebook', 'needs_reconnect', `${what} returned no token`, false);
    return {
      accessToken: raw.access_token,
      ...(raw.expires_in && { expiresAt: new Date(deps.now() + raw.expires_in * 1000) }),
    };
  };

  const tokenEndpoint = (params: Record<string, string>) => {
    const url = new URL(`${base}/oauth/access_token`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return get<RawToken>(url);
  };

  return {
    graphVersion: config.graphVersion,
    authorizeUrl({ state }) {
      const url = new URL(`https://www.facebook.com/${config.graphVersion}/dialog/oauth`);
      url.searchParams.set('client_id', config.appId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('config_id', config.configId);
      return url.toString();
    },
    async exchangeCode(code) {
      const res = await tokenEndpoint({
        client_id: config.appId,
        redirect_uri: config.redirectUri,
        client_secret: config.appSecret,
        code,
      });
      return toToken(res.body, 'Code exchange');
    },
    async exchangeLongLived(userToken) {
      const res = await tokenEndpoint({
        grant_type: 'fb_exchange_token',
        client_id: config.appId,
        client_secret: config.appSecret,
        fb_exchange_token: userToken,
      });
      return toToken(res.body, 'Long-lived token exchange');
    },
    async fetchUser(userToken) {
      const res = await graph<{ id?: string; name?: string }>('/me', userToken, {
        fields: 'id,name',
      });
      const id = res.body.id;
      if (!id || !NUMERIC_ID.test(id))
        throw new PlatformError('facebook', 'unknown', '/me returned no user id', true);
      return { id, name: res.body.name ?? id };
    },
    async fetchGrantedScopes(userToken) {
      const res = await graph<{ data?: Array<{ permission?: string; status?: string }> }>(
        '/me/permissions',
        userToken,
      );
      return (res.body.data ?? [])
        .filter((p) => p.status === 'granted' && p.permission)
        .map((p) => p.permission as string);
    },
    async fetchAssets(userToken) {
      const pages: RawPage[] = [];
      let res = await graph<RawAccounts>('/me/accounts', userToken, {
        fields: PAGE_FIELDS,
        limit: '100',
      });
      pages.push(...(res.body.data ?? []));
      for (let i = 1; i < MAX_ACCOUNT_PAGES && res.body.paging?.next; i++) {
        const next = new URL(res.body.paging.next);
        // Only ever follow Graph's own paging links (never an arbitrary host from a response).
        if (next.origin !== GRAPH_HOST) break;
        next.searchParams.set('appsecret_proof', appSecretProof(userToken, config.appSecret));
        res = await get<RawAccounts>(next);
        pages.push(...(res.body.data ?? []));
      }
      return toAssets(pages);
    },
  };
}

/**
 * Pages whose token is missing, or where the user lacks the CREATE_CONTENT task (Reels
 * Publishing API requirement), are skipped: Studio could not publish to them.
 */
export function toAssets(pages: RawPage[]): { assets: MetaAsset[]; skippedPages: number } {
  const assets: MetaAsset[] = [];
  let skippedPages = 0;
  for (const page of pages) {
    const canPublish = !page.tasks || page.tasks.includes('CREATE_CONTENT');
    if (!page.id || !NUMERIC_ID.test(page.id) || !page.access_token || !canPublish) {
      skippedPages++;
      continue;
    }
    assets.push({
      platform: 'facebook',
      accountId: page.id,
      accountName: (page.name ?? page.id).slice(0, 200),
      accessToken: page.access_token,
      pageId: page.id,
    });
    const ig = page.instagram_business_account;
    if (ig?.id && NUMERIC_ID.test(ig.id)) {
      assets.push({
        platform: 'instagram',
        accountId: ig.id,
        accountName: (ig.username ? `@${ig.username}` : (ig.name ?? ig.id)).slice(0, 200),
        accessToken: page.access_token,
        pageId: page.id,
      });
    }
  }
  return { assets, skippedPages };
}

type Env = Record<string, string | undefined>;

/** Graph version for the login: META_GRAPH_VERSION, else the publishers' META_GRAPH_API_VERSION. */
export function metaGraphVersion(env: Env = process.env): string {
  return (
    env.META_GRAPH_VERSION?.trim() || env.META_GRAPH_API_VERSION?.trim() || DEFAULT_GRAPH_VERSION
  );
}

/** The callback Studio registers with Meta (same route as the other platforms' OAuth). */
export function metaRedirectUri(env: Env = process.env): string | undefined {
  const explicit = env.META_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const app = env.APP_URL?.trim();
  return app
    ? `${app.replace(/\/+$/, '')}/api/studio/platform-connections/oauth-callback`
    : undefined;
}

/** True when the operator has configured Studio's Meta app (Connect is shown). */
export function metaConnectConfigured(env: Env = process.env): boolean {
  return Boolean(
    env.META_APP_ID?.trim() &&
    env.META_APP_SECRET?.trim() &&
    env.META_LOGIN_CONFIG_ID?.trim() &&
    metaRedirectUri(env),
  );
}

export function metaOAuthFromEnv(
  env: Env = process.env,
  deps: Deps = { fetchImpl: fetch, now: Date.now },
): MetaOAuthClient {
  const redirectUri = metaRedirectUri(env);
  const appId = env.META_APP_ID?.trim();
  const appSecret = env.META_APP_SECRET?.trim();
  const configId = env.META_LOGIN_CONFIG_ID?.trim();
  if (!appId || !appSecret || !configId || !redirectUri)
    throw new ConfigurationError(
      'Meta connect needs META_APP_ID, META_APP_SECRET, META_LOGIN_CONFIG_ID and APP_URL',
    );
  return createMetaOAuth(
    { appId, appSecret, configId, redirectUri, graphVersion: metaGraphVersion(env) },
    deps,
  );
}
