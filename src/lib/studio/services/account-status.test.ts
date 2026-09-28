import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createTranslator } from 'next-intl';
import pino from 'pino';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '../../audit';
import { ConfigurationError, PlatformError } from '../../errors';
import { ALL_MESSAGES } from '../../i18n/all-messages';
import { LOCALES } from '../../i18n/locales';
import { createLocalKeyProvider } from '../crypto/envelope';
import type { NotificationInput, Notifier } from '../notifications/notifier';
import { createStoredMetaCredentials } from '../platforms/meta-credentials';
import {
  createLinkedInOAuth,
  createTikTokOAuth,
  createXOAuth,
  createYouTubeOAuth,
  type OAuthClient,
  type OAuthPlatform,
} from '../platforms/oauth';
import { sealTokens } from '../platforms/tokens';
import {
  accountCheckConfig,
  checkPlatformAccounts,
  classifyCheckError,
  CHECK_ACTOR,
  reconnectNotification,
} from './account-status';

// BACKLOG 17.3 — the daily account-status check: an auth failure marks the connection
// needs_reconnect, notifies its owner and is audited; a transient failure changes nothing.

describe('accountCheckConfig', () => {
  it('defaults to once a day, 100 per run, 2 s apart, Graph v26.0', () => {
    expect(accountCheckConfig({})).toEqual({
      intervalMs: 24 * 3_600_000,
      batch: 100,
      spacingMs: 2_000,
      graphVersion: 'v26.0',
    });
  });

  it('reads and validates the settings', () => {
    expect(
      accountCheckConfig({
        STUDIO_ACCOUNT_CHECK_INTERVAL_HOURS: '12',
        STUDIO_ACCOUNT_CHECK_BATCH: '10',
        STUDIO_ACCOUNT_CHECK_SPACING_MS: '0',
        META_GRAPH_API_VERSION: 'v27.0',
      }),
    ).toEqual({ intervalMs: 12 * 3_600_000, batch: 10, spacingMs: 0, graphVersion: 'v27.0' });
    for (const [name, bad] of [
      ['STUDIO_ACCOUNT_CHECK_INTERVAL_HOURS', '0'],
      ['STUDIO_ACCOUNT_CHECK_INTERVAL_HOURS', '169'],
      ['STUDIO_ACCOUNT_CHECK_BATCH', '1001'],
      ['STUDIO_ACCOUNT_CHECK_SPACING_MS', '-1'],
      ['STUDIO_ACCOUNT_CHECK_SPACING_MS', '1.5'],
    ] as const)
      expect(() => accountCheckConfig({ [name]: bad })).toThrow(ConfigurationError);
  });
});

describe('classifyCheckError', () => {
  it('only an authentication refusal means reconnect', () => {
    expect(classifyCheckError(new PlatformError('x', 'needs_reconnect', 'HTTP 401', false))).toBe(
      'needs_reconnect',
    );
    for (const cls of [
      'rate_limited',
      'unavailable',
      'timeout',
      'invalid_request',
      'unknown',
    ] as const)
      expect(classifyCheckError(new PlatformError('x', cls, 'e', true))).toBe('unreachable');
    expect(classifyCheckError(new Error('socket hang up'))).toBe('unreachable');
  });
});

describe('reconnectNotification', () => {
  const base = {
    id: 'conn-1',
    organisationId: 'org-1',
    platform: 'tiktok',
    platformAccountName: '@cafe',
    connectedByUserId: 'user-1',
    connectedAt: new Date('2026-09-01T00:00:00Z'),
  };

  it('goes to the person who connected it, once per connection lifetime', () => {
    const n = reconnectNotification(base);
    expect(n).toMatchObject({
      organisationId: 'org-1',
      userId: 'user-1',
      kind: 'connection_needs_reconnect',
      link: '/connections',
      dedupeKey: `connection_needs_reconnect:conn-1:${base.connectedAt.getTime()}`,
      message: {
        key: 'connectionNeedsReconnect',
        params: { account: '@cafe', platform: 'tiktok' },
      },
    });
  });

  it('tells the whole organisation about a Core-registered Meta channel', () => {
    const n = reconnectNotification({
      ...base,
      platform: 'instagram',
      connectedByUserId: 'system:postmind-core',
    });
    expect(n.userId).toBeNull();
    expect(n.message?.key).toBe('metaConnectionNeedsReconnect');
    expect(n.body).toContain('PostMind settings');
  });

  it.each(LOCALES)('renders in %s without a placeholder left', (locale) => {
    const t = createTranslator({
      locale,
      messages: ALL_MESSAGES[locale],
      namespace: 'notifications',
    });
    for (const key of ['connectionNeedsReconnect', 'metaConnectionNeedsReconnect'] as const) {
      for (const part of ['title', 'body'] as const) {
        const text = t(`${key}.${part}`, { account: '@cafe', platform: 'TikTok' });
        expect(text, `${locale} ${key}.${part}`).not.toMatch(/[{}]/);
        if (part === 'title') expect(text).toContain('@cafe');
      }
    }
  });
});

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('checkPlatformAccounts', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `svc-acct-${randomUUID()}`;
  const keys = createLocalKeyProvider(randomBytes(32).toString('base64'), 'test');
  const NOW = Date.parse('2026-09-28T12:00:00Z');
  const logger = pino({ level: 'silent' });

  afterAll(async () => {
    await db.platformConnection.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  async function connection(
    platform: string,
    accountId: string,
    extra: { expired?: boolean; refreshToken?: string; connectedByUserId?: string } = {},
  ) {
    const sealed = await sealTokens(keys, org, platform, {
      accessToken: `token-${accountId}`,
      ...(extra.refreshToken && { refreshToken: extra.refreshToken }),
      ...(extra.expired && { expiresAt: new Date(NOW - 60_000) }),
      scopes: [],
    });
    return db.platformConnection.create({
      data: {
        organisationId: org,
        businessId: 'biz',
        platform,
        platformAccountId: accountId,
        platformAccountName: `@${accountId}`,
        ...sealed,
        scopes: [],
        state: 'active',
        connectedByUserId: extra.connectedByUserId ?? 'user-1',
      },
    });
  }

  /** Routes each request by URL; records what was called. */
  function platformFetch(routes: Array<[match: string, reply: () => Response]>) {
    const calls: string[] = [];
    const fn = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      const route = routes.find(([match]) => url.includes(match));
      if (!route) throw new Error(`unexpected request ${url}`);
      return route[1]();
    });
    return { fetchImpl: fn as unknown as typeof fetch, calls };
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('marks refused accounts, leaves unreachable ones alone and spreads the calls', async () => {
    const tiktok = await connection('tiktok', 'tt-ok');
    const x = await connection('x', 'x-revoked');
    const youtube = await connection('youtube', 'yt-down');
    const youtubeRefresh = await connection('youtube', 'yt-refresh-refused', {
      expired: true,
      refreshToken: 'refresh-yt',
    });
    const facebook = await connection('facebook', 'fb-page', {
      connectedByUserId: 'system:postmind-core',
    });
    const instagram = await connection('instagram', 'ig-user');
    const linkedinA = await connection('linkedin', 'li-a');
    const linkedinB = await connection('linkedin', 'li-b');

    const { fetchImpl, calls } = platformFetch([
      ['open.tiktokapis.com/v2/user/info/', () => json({ data: { user: { open_id: 'tt-ok' } } })],
      ['api.x.com/2/users/me', () => json({ title: 'Unauthorized' }, 401)],
      ['oauth2.googleapis.com/token', () => json({ error: 'invalid_grant' }, 400)],
      ['youtube/v3/channels', () => json({ error: { message: 'backend error' } }, 503)],
      [
        'graph.facebook.com/v26.0/me?fields=id',
        () =>
          json({ error: { message: 'Session has expired', code: 190, error_subcode: 463 } }, 400),
      ],
      [
        'graph.facebook.com/v26.0/ig-user/content_publishing_limit',
        () => json({ data: [{ quota_usage: 1 }] }),
      ],
      ['api.linkedin.com/v2/userinfo', () => json({ message: 'Too many requests' }, 429)],
    ]);
    const config = { clientId: 'id', clientSecret: 'secret', redirectUri: 'https://x' };
    const oauthDeps = { fetchImpl, now: () => NOW };
    const clients: Record<OAuthPlatform, OAuthClient> = {
      tiktok: createTikTokOAuth(config, oauthDeps),
      youtube: createYouTubeOAuth(config, oauthDeps),
      x: createXOAuth(config, oauthDeps),
      linkedin: createLinkedInOAuth(config, oauthDeps),
    };
    const notified: NotificationInput[] = [];
    const notifier: Notifier = {
      notify: async (input) => {
        notified.push(input);
        return { created: true };
      },
      notifyStaff: async () => 0,
    };
    const audits: AuditEntry[] = [];
    const sleep = vi.fn(async () => undefined);
    const deps = {
      db,
      keys,
      oauth: (p: OAuthPlatform) => clients[p],
      meta: createStoredMetaCredentials({ db, keys, now: () => NOW }),
      fetchImpl,
      audit: (e: AuditEntry) => audits.push(e),
      logger,
      now: () => NOW,
      sleep,
      notifier,
      organisationId: org,
      config: { ...accountCheckConfig({}), spacingMs: 1_000 },
    };

    const result = await checkPlatformAccounts(deps);

    // The documented cheap reads were used.
    expect(calls).toEqual(
      expect.arrayContaining([
        'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name',
        'https://api.x.com/2/users/me',
        'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
        'https://graph.facebook.com/v26.0/me?fields=id',
        'https://graph.facebook.com/v26.0/ig-user/content_publishing_limit?fields=quota_usage',
        'https://api.linkedin.com/v2/userinfo',
      ]),
    );
    // A platform answering 429 is left alone for the rest of the run.
    expect(calls.filter((u) => u.includes('linkedin'))).toHaveLength(1);
    expect(result).toMatchObject({ checked: 7, ok: 2, unreachable: 2, deferred: 1 });
    expect(result.needsReconnect.sort()).toEqual([x.id, youtubeRefresh.id, facebook.id].sort());
    expect(sleep).toHaveBeenCalledTimes(6);
    expect(sleep).toHaveBeenCalledWith(1_000);

    const state = async (id: string) =>
      db.platformConnection.findUniqueOrThrow({
        where: { id },
        select: { state: true, statusCheckOutcome: true, statusCheckedAt: true },
      });
    expect(await state(tiktok.id)).toEqual({
      state: 'active',
      statusCheckOutcome: 'ok',
      statusCheckedAt: new Date(NOW),
    });
    expect(await state(instagram.id)).toMatchObject({ state: 'active', statusCheckOutcome: 'ok' });
    for (const refused of [x, youtubeRefresh, facebook])
      expect(await state(refused.id)).toMatchObject({
        state: 'needs_reconnect',
        statusCheckOutcome: 'needs_reconnect',
      });
    // Transient failures never flip the state.
    for (const transient of [youtube, linkedinA])
      expect(await state(transient.id)).toMatchObject({
        state: 'active',
        statusCheckOutcome: 'unreachable',
      });
    expect(await state(linkedinB.id)).toMatchObject({ state: 'active', statusCheckedAt: null });

    // One notification and one audit entry per refused account.
    expect(notified.map((n) => n.message?.key).sort()).toEqual([
      'connectionNeedsReconnect',
      'connectionNeedsReconnect',
      'metaConnectionNeedsReconnect',
    ]);
    expect(
      notified.find((n) => n.message?.key === 'metaConnectionNeedsReconnect')?.userId,
    ).toBeNull();
    expect(audits).toHaveLength(3);
    expect(audits[0]).toMatchObject({
      actorUserId: CHECK_ACTOR,
      organisationId: org,
      action: 'studio.connection.needs_reconnect',
      resource: { type: 'platform_connection' },
    });

    // The next hourly run only picks up what this one deferred (the rest is checked tomorrow).
    calls.length = 0;
    const next = await checkPlatformAccounts(deps);
    expect(next.checked).toBe(1);
    expect(calls).toEqual(['https://api.linkedin.com/v2/userinfo']);
    expect(notified).toHaveLength(3);

    // A day later every active account is due again; refused ones are not re-checked.
    calls.length = 0;
    const tomorrow = await checkPlatformAccounts({
      ...deps,
      now: () => NOW + 25 * 3_600_000,
    });
    expect(tomorrow.checked + tomorrow.deferred).toBe(5);
    expect(calls.some((u) => u.includes('api.x.com'))).toBe(false);
  });
});
