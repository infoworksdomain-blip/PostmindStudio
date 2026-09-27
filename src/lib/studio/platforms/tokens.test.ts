import { randomBytes } from 'node:crypto';
import type { PlatformConnection, PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PlatformError } from '../../errors';
import { createLocalKeyProvider, decryptSecret, tokenContext } from '../crypto/envelope';
import { getAccessToken, REFRESH_MARGIN_MS, sealTokens, type TokenDeps } from './tokens';
import type { OAuthClient, OAuthPlatform, TokenSet } from './oauth';

const keys = createLocalKeyProvider(randomBytes(32).toString('base64'), 'test');

async function seal(
  organisationId: string,
  platform: string,
  accessToken: string,
  refreshToken?: string,
) {
  return sealTokens(keys, organisationId, platform, {
    accessToken,
    ...(refreshToken && { refreshToken }),
    scopes: [],
  });
}

function makeConnection(overrides: Partial<PlatformConnection> = {}): PlatformConnection {
  return {
    id: 'conn-1',
    organisationId: 'org-1',
    businessId: 'biz-1',
    platform: 'tiktok',
    platformAccountId: 'account-1',
    platformAccountName: 'Studio Account',
    encryptedAccessToken: '',
    encryptedRefreshToken: null,
    accessTokenExpiresAt: null,
    scopes: [],
    state: 'active',
    connectedByUserId: 'user-1',
    connectedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as PlatformConnection;
}

function fakeDb() {
  return {
    platformConnection: {
      updateMany: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
  } as unknown as PrismaClient;
}

function fakeOAuthClient(overrides: Partial<OAuthClient> = {}): OAuthClient {
  return {
    platform: 'tiktok',
    usesPkce: false,
    authorizeUrl: vi.fn(() => 'https://example.com/authorize'),
    exchangeCode: vi.fn(),
    refresh: vi.fn(),
    fetchAccount: vi.fn(),
    ...overrides,
  };
}

describe('sealTokens', () => {
  it('encrypts the access token and, when present, the refresh token', async () => {
    const tokens: TokenSet = {
      accessToken: 'at-plain',
      refreshToken: 'rt-plain',
      expiresAt: new Date('2026-02-01T00:00:00Z'),
      scopes: ['a'],
    };
    const sealed = await sealTokens(keys, 'org-1', 'tiktok', tokens);
    expect(sealed.encryptedAccessToken).not.toContain('at-plain');
    expect(sealed.encryptedRefreshToken).not.toBeNull();
    expect(sealed.encryptedRefreshToken).not.toContain('rt-plain');
    expect(sealed.accessTokenExpiresAt).toEqual(tokens.expiresAt);

    await expect(
      decryptSecret(
        keys,
        sealed.encryptedAccessToken,
        tokenContext({ organisationId: 'org-1', platform: 'tiktok', kind: 'access' }),
      ),
    ).resolves.toBe('at-plain');
    await expect(
      decryptSecret(
        keys,
        sealed.encryptedRefreshToken!,
        tokenContext({ organisationId: 'org-1', platform: 'tiktok', kind: 'refresh' }),
      ),
    ).resolves.toBe('rt-plain');
  });

  it('leaves encryptedRefreshToken null and accessTokenExpiresAt null when absent', async () => {
    const sealed = await sealTokens(keys, 'org-1', 'tiktok', { accessToken: 'at', scopes: [] });
    expect(sealed.encryptedRefreshToken).toBeNull();
    expect(sealed.accessTokenExpiresAt).toBeNull();
  });
});

describe('getAccessToken', () => {
  it('throws needs_reconnect without touching storage when the connection is not active', async () => {
    const db = fakeDb();
    const oauth = vi.fn(() => fakeOAuthClient());
    const connection = makeConnection({ state: 'needs_reconnect' });
    const deps: TokenDeps = { db, keys, oauth, now: () => 0 };

    await expect(getAccessToken(deps, connection)).rejects.toMatchObject({
      errorClass: 'needs_reconnect',
      retryable: false,
    });
    expect(oauth).not.toHaveBeenCalled();
  });

  it('returns the decrypted access token without refreshing when it is not near expiry', async () => {
    const now = () => 1_000_000;
    const sealed = await seal('org-1', 'tiktok', 'fresh-access-token');
    const connection = makeConnection({
      encryptedAccessToken: sealed.encryptedAccessToken,
      accessTokenExpiresAt: new Date(now() + REFRESH_MARGIN_MS + 60_000),
    });
    const db = fakeDb();
    const oauth = vi.fn(() => fakeOAuthClient());
    const deps: TokenDeps = { db, keys, oauth, now };

    const token = await getAccessToken(deps, connection);
    expect(token).toBe('fresh-access-token');
    expect(oauth).not.toHaveBeenCalled();
    expect(db.platformConnection.updateMany).not.toHaveBeenCalled();
  });

  it('treats a connection with no expiry set as fresh', async () => {
    const sealed = await seal('org-1', 'tiktok', 'no-expiry-token');
    const connection = makeConnection({ encryptedAccessToken: sealed.encryptedAccessToken });
    const deps: TokenDeps = {
      db: fakeDb(),
      keys,
      oauth: vi.fn(() => fakeOAuthClient()),
      now: () => 0,
    };
    await expect(getAccessToken(deps, connection)).resolves.toBe('no-expiry-token');
  });

  it('refreshes a near-expiry token and CAS-writes the new tokens', async () => {
    const now = () => 1_000_000;
    const sealed = await seal('org-1', 'tiktok', 'old-access', 'old-refresh');
    const connection = makeConnection({
      encryptedAccessToken: sealed.encryptedAccessToken,
      encryptedRefreshToken: sealed.encryptedRefreshToken,
      accessTokenExpiresAt: new Date(now() + REFRESH_MARGIN_MS - 1000),
    });
    const refreshedTokens: TokenSet = {
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      scopes: [],
    };
    const oauthClient = fakeOAuthClient({ refresh: vi.fn(async () => refreshedTokens) });
    const oauth = vi.fn((_platform: OAuthPlatform) => oauthClient);
    const db = fakeDb();
    (db.platformConnection.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    const deps: TokenDeps = { db, keys, oauth, now };

    const token = await getAccessToken(deps, connection);
    expect(token).toBe('new-access');
    expect(oauthClient.refresh).toHaveBeenCalledWith('old-refresh');
    expect(db.platformConnection.updateMany).toHaveBeenCalledTimes(1);
    const call = (db.platformConnection.updateMany as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.where).toEqual({
      id: connection.id,
      encryptedRefreshToken: sealed.encryptedRefreshToken,
    });
    expect(call.data.encryptedAccessToken).not.toContain('new-access');
    await expect(
      decryptSecret(
        keys,
        call.data.encryptedRefreshToken,
        tokenContext({ organisationId: 'org-1', platform: 'tiktok', kind: 'refresh' }),
      ),
    ).resolves.toBe('new-refresh');
  });

  it('keeps the current refresh token when the platform does not return a new one', async () => {
    const now = () => 1_000_000;
    const sealed = await seal('org-1', 'tiktok', 'old-access', 'old-refresh');
    const connection = makeConnection({
      encryptedAccessToken: sealed.encryptedAccessToken,
      encryptedRefreshToken: sealed.encryptedRefreshToken,
      accessTokenExpiresAt: new Date(now() + REFRESH_MARGIN_MS - 1000),
    });
    const refreshedTokens: TokenSet = { accessToken: 'new-access', scopes: [] };
    const oauthClient = fakeOAuthClient({ refresh: vi.fn(async () => refreshedTokens) });
    const db = fakeDb();
    (db.platformConnection.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    const deps: TokenDeps = { db, keys, oauth: vi.fn(() => oauthClient), now };

    await getAccessToken(deps, connection);
    const call = (db.platformConnection.updateMany as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    await expect(
      decryptSecret(
        keys,
        call.data.encryptedRefreshToken,
        tokenContext({ organisationId: 'org-1', platform: 'tiktok', kind: 'refresh' }),
      ),
    ).resolves.toBe('old-refresh');
  });

  it('marks the connection needs_reconnect and throws when there is no refresh token', async () => {
    const now = () => 1_000_000;
    const sealed = await seal('org-1', 'tiktok', 'old-access');
    const connection = makeConnection({
      encryptedAccessToken: sealed.encryptedAccessToken,
      encryptedRefreshToken: null,
      accessTokenExpiresAt: new Date(now() + REFRESH_MARGIN_MS - 1000),
    });
    const db = fakeDb();
    const deps: TokenDeps = { db, keys, oauth: vi.fn(() => fakeOAuthClient()), now };

    await expect(getAccessToken(deps, connection)).rejects.toMatchObject({
      errorClass: 'needs_reconnect',
      retryable: false,
    });
    expect(db.platformConnection.update).toHaveBeenCalledWith({
      where: { id: connection.id },
      data: { state: 'needs_reconnect' },
    });
  });

  it('marks needs_reconnect and rethrows when the platform refuses the refresh', async () => {
    const now = () => 1_000_000;
    const sealed = await seal('org-1', 'tiktok', 'old-access', 'old-refresh');
    const connection = makeConnection({
      encryptedAccessToken: sealed.encryptedAccessToken,
      encryptedRefreshToken: sealed.encryptedRefreshToken,
      accessTokenExpiresAt: new Date(now() + REFRESH_MARGIN_MS - 1000),
    });
    const refuseError = new PlatformError('tiktok', 'needs_reconnect', 'grant revoked', false);
    const oauthClient = fakeOAuthClient({
      refresh: vi.fn(async () => Promise.reject(refuseError)),
    });
    const db = fakeDb();
    const deps: TokenDeps = { db, keys, oauth: vi.fn(() => oauthClient), now };

    await expect(getAccessToken(deps, connection)).rejects.toBe(refuseError);
    expect(db.platformConnection.update).toHaveBeenCalledWith({
      where: { id: connection.id },
      data: { state: 'needs_reconnect' },
    });
    expect(db.platformConnection.updateMany).not.toHaveBeenCalled();
  });

  it('does not mark needs_reconnect for other refresh error classes', async () => {
    const now = () => 1_000_000;
    const sealed = await seal('org-1', 'tiktok', 'old-access', 'old-refresh');
    const connection = makeConnection({
      encryptedAccessToken: sealed.encryptedAccessToken,
      encryptedRefreshToken: sealed.encryptedRefreshToken,
      accessTokenExpiresAt: new Date(now() + REFRESH_MARGIN_MS - 1000),
    });
    const transientError = new PlatformError('tiktok', 'unavailable', 'try again', true);
    const oauthClient = fakeOAuthClient({
      refresh: vi.fn(async () => Promise.reject(transientError)),
    });
    const db = fakeDb();
    const deps: TokenDeps = { db, keys, oauth: vi.fn(() => oauthClient), now };

    await expect(getAccessToken(deps, connection)).rejects.toBe(transientError);
    expect(db.platformConnection.update).not.toHaveBeenCalled();
  });

  it('falls back to the latest row when it loses the CAS race on refresh', async () => {
    const now = () => 1_000_000;
    const sealed = await seal('org-1', 'tiktok', 'old-access', 'old-refresh');
    const connection = makeConnection({
      encryptedAccessToken: sealed.encryptedAccessToken,
      encryptedRefreshToken: sealed.encryptedRefreshToken,
      accessTokenExpiresAt: new Date(now() + REFRESH_MARGIN_MS - 1000),
    });
    const refreshedTokens: TokenSet = { accessToken: 'losing-refresh-access', scopes: [] };
    const oauthClient = fakeOAuthClient({ refresh: vi.fn(async () => refreshedTokens) });
    const db = fakeDb();
    (db.platformConnection.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
    const winnerSealed = await seal('org-1', 'tiktok', 'winner-access', 'winner-refresh');
    const latestConnection = makeConnection({
      encryptedAccessToken: winnerSealed.encryptedAccessToken,
      encryptedRefreshToken: winnerSealed.encryptedRefreshToken,
    });
    (db.platformConnection.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
      latestConnection,
    );
    const deps: TokenDeps = { db, keys, oauth: vi.fn(() => oauthClient), now };

    const token = await getAccessToken(deps, connection);
    expect(token).toBe('winner-access');
    expect(db.platformConnection.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: connection.id },
    });
  });
});
