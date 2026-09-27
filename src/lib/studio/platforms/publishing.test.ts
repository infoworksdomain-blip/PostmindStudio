import { randomBytes } from 'node:crypto';
import type {
  PlatformConnection,
  PrismaClient,
  VideoPublication,
  VideoRender,
} from '@prisma/client';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { NotFoundError, PlatformError } from '../../errors';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import { createLocalKeyProvider } from '../crypto/envelope';
import type { MetaCredentialSource } from './meta';
import type { OAuthClient, OAuthPlatform } from './oauth';
import { sealTokens } from './tokens';
import {
  createEngagementClient,
  publicationMetadata,
  resolveCredentials,
  videoSource,
  type PublishingDeps,
} from './publishing';

const keys = createLocalKeyProvider(randomBytes(32).toString('base64'), 'test');

function fakeLogger(): Logger {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function makePublication(overrides: Partial<VideoPublication> = {}): VideoPublication {
  return {
    id: 'pub-1',
    organisationId: 'org-1',
    projectId: 'project-1',
    renderId: 'render-1',
    platform: 'tiktok',
    platformAccountId: 'account-1',
    scheduledFor: null,
    publishedAt: null,
    platformPostId: null,
    platformUrl: null,
    state: 'pending',
    caption: null,
    hashtags: [],
    errorReason: null,
    errorCode: null,
    retryCount: 0,
    metadata: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as unknown as VideoPublication;
}

function makeConnection(overrides: Partial<PlatformConnection> = {}): PlatformConnection {
  return {
    id: 'conn-1',
    organisationId: 'org-1',
    businessId: 'biz-1',
    platform: 'tiktok',
    platformAccountId: 'account-42',
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

describe('publicationMetadata', () => {
  it('returns the metadata object when it is a plain object', () => {
    const pub = makePublication({ metadata: { connectionId: 'conn-9', title: 'Hi' } });
    expect(publicationMetadata(pub)).toEqual({ connectionId: 'conn-9', title: 'Hi' });
  });

  it('returns an empty object when metadata is null', () => {
    expect(publicationMetadata(makePublication({ metadata: null }))).toEqual({});
  });

  it('returns an empty object when metadata is an array (not a plain object)', () => {
    expect(publicationMetadata(makePublication({ metadata: [1, 2] as never }))).toEqual({});
  });
});

describe('resolveCredentials', () => {
  it('fetches Meta credentials for a platform routed through Engagement', async () => {
    const meta: MetaCredentialSource = {
      getCredentials: vi.fn(async () => ({
        accessToken: 'meta-access-token',
        accountId: 'ig-account-1',
      })),
    };
    const publication = makePublication({
      platform: 'instagram_reel',
      platformAccountId: 'ig-account-1',
    });
    const deps = {
      db: {} as PrismaClient,
      meta,
      keys,
      oauth: vi.fn(),
      now: () => 0,
    } as unknown as PublishingDeps;

    const result = await resolveCredentials(deps, publication);
    expect(result).toEqual({ accessToken: 'meta-access-token', accountId: 'ig-account-1' });
    expect(meta.getCredentials).toHaveBeenCalledWith({
      organisationId: 'org-1',
      platform: 'instagram',
      platformAccountId: 'ig-account-1',
    });
  });

  it('resolves a Studio-owned connection and decrypts its access token', async () => {
    const sealed = await sealTokens(keys, 'org-1', 'tiktok', {
      accessToken: 'studio-access-token',
      scopes: [],
    });
    const connection = makeConnection({ encryptedAccessToken: sealed.encryptedAccessToken });
    const findFirst = vi.fn(async () => connection);
    const publication = makePublication({
      platform: 'tiktok',
      metadata: { connectionId: connection.id },
    });
    const deps = {
      db: { platformConnection: { findFirst } } as unknown as PrismaClient,
      meta: { getCredentials: vi.fn() },
      keys,
      oauth: vi.fn((_p: OAuthPlatform) => ({}) as OAuthClient),
      now: () => 0,
    } as unknown as PublishingDeps;

    const result = await resolveCredentials(deps, publication);
    expect(result).toEqual({ accessToken: 'studio-access-token', accountId: 'account-42' });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: connection.id, organisationId: 'org-1' },
    });
  });

  it('throws needs_reconnect when the publication metadata has no connectionId', async () => {
    const publication = makePublication({ platform: 'tiktok', metadata: {} });
    const deps = {
      db: { platformConnection: { findFirst: vi.fn() } } as unknown as PrismaClient,
      meta: { getCredentials: vi.fn() },
      keys,
      oauth: vi.fn(),
      now: () => 0,
    } as unknown as PublishingDeps;

    await expect(resolveCredentials(deps, publication)).rejects.toMatchObject({
      errorClass: 'needs_reconnect',
      retryable: false,
    });
  });

  it('throws needs_reconnect when the referenced connection no longer exists', async () => {
    const findFirst = vi.fn(async () => null);
    const publication = makePublication({ platform: 'tiktok', metadata: { connectionId: 'gone' } });
    const deps = {
      db: { platformConnection: { findFirst } } as unknown as PrismaClient,
      meta: { getCredentials: vi.fn() },
      keys,
      oauth: vi.fn(),
      now: () => 0,
    } as unknown as PublishingDeps;

    await expect(resolveCredentials(deps, publication)).rejects.toBeInstanceOf(PlatformError);
  });
});

describe('videoSource', () => {
  it('reads size and builds a lazy signed-URL video source from storage', async () => {
    const { storage } = memoryStorage();
    await storage.put({
      bucket: 'studio-renders',
      key: 'render-1.mp4',
      body: new Uint8Array([1, 2, 3, 4]),
      contentType: 'video/mp4',
    });
    const render = {
      s3Bucket: 'studio-renders',
      s3Key: 'render-1.mp4',
      durationSec: 12.5,
      aspectRatio: '9:16',
    } as VideoRender;

    const source = await videoSource({ storage }, render);
    expect(source.sizeBytes).toBe(4);
    expect(source.contentType).toBe('video/mp4');
    expect(source.durationSec).toBe(12.5);
    expect(source.aspectRatio).toBe('9:16');
    expect(source.signedUrl).toBe('https://signed.example/studio-renders/render-1.mp4');
    await expect(source.read(1, 2)).resolves.toEqual(new Uint8Array([2, 3]));
  });

  it('throws NotFoundError when the render file is empty or missing', async () => {
    const { storage } = memoryStorage();
    await storage.put({
      bucket: 'studio-renders',
      key: 'empty.mp4',
      body: new Uint8Array(),
      contentType: 'video/mp4',
    });
    const render = {
      s3Bucket: 'studio-renders',
      s3Key: 'empty.mp4',
      durationSec: 1,
      aspectRatio: '9:16',
    } as VideoRender;

    await expect(videoSource({ storage }, render)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('createEngagementClient', () => {
  it('skips attribution and logs a warning when unconfigured', async () => {
    const logger = fakeLogger();
    const { fetch: fetchImpl, requests } = fakeFetch();
    const client = createEngagementClient({
      baseUrl: undefined,
      serviceToken: undefined,
      fetchImpl,
      logger,
    });
    await client.attributePublication({
      publicationId: 'pub-1',
      organisationId: 'org-1',
      platform: 'tiktok',
      platformPostId: 'post-1',
    });
    expect(requests).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      { publicationId: 'pub-1' },
      expect.stringContaining('attribution skipped'),
    );
  });

  it('posts attribution with the X-Service-Token header and JSON body', async () => {
    const logger = fakeLogger();
    const { fetch: fetchImpl, requests } = fakeFetch(json({ ok: true }));
    const client = createEngagementClient({
      baseUrl: 'https://engagement.example/',
      serviceToken: 'svc-token-1',
      fetchImpl,
      logger,
    });
    const body = {
      publicationId: 'pub-1',
      organisationId: 'org-1',
      platform: 'tiktok',
      platformPostId: 'post-1',
    };
    await client.attributePublication(body);

    expect(requests[0]?.url).toBe(
      'https://engagement.example/api/engagement/internal/publications/attribute',
    );
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers['x-service-token']).toBe('svc-token-1');
    expect(requests[0]?.body).toEqual(body);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs an error (without throwing) when Engagement rejects the attribution', async () => {
    const logger = fakeLogger();
    const { fetch: fetchImpl } = fakeFetch(json({ error: 'nope' }, 500));
    const client = createEngagementClient({
      baseUrl: 'https://engagement.example',
      serviceToken: 'svc-token-1',
      fetchImpl,
      logger,
    });
    await expect(
      client.attributePublication({
        publicationId: 'pub-1',
        organisationId: 'org-1',
        platform: 'tiktok',
        platformPostId: 'post-1',
      }),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ status: 500 }),
      expect.stringContaining('attribution rejected'),
    );
  });

  it('swallows a network failure and logs it instead of throwing', async () => {
    const logger = fakeLogger();
    const { fetch: fetchImpl } = fakeFetch(new Error('network down'));
    const client = createEngagementClient({
      baseUrl: 'https://engagement.example',
      serviceToken: 'svc-token-1',
      fetchImpl,
      logger,
    });
    await expect(
      client.attributePublication({
        publicationId: 'pub-1',
        organisationId: 'org-1',
        platform: 'tiktok',
        platformPostId: 'post-1',
      }),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('attribution failed'),
    );
  });
});
