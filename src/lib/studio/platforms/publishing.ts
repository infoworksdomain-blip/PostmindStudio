import type { PrismaClient, VideoPublication, VideoRender } from '@prisma/client';
import type { Logger } from 'pino';
import { NotFoundError, PlatformError } from '../../errors';
import type { DataKeyProvider } from '../crypto/envelope';
import type { Platform } from '../services/catalog';
import type { AssetStorage } from '../storage';
import type { VideoSource } from './interface';
import type { MetaCredentialSource } from './meta';
import type { OAuthClient, OAuthPlatform } from './oauth';
import type { PublisherRegistry } from './registry';
import { PLATFORM_RULES } from './rules';
import { getAccessToken } from './tokens';

// Shared by the publish worker and the publications API (takedown).

/**
 * Pull-upload URL lifetime. Meta fetches the file while the container/upload is created, so a
 * short-lived bearer URL limits exposure if it leaks from a platform log.
 */
export const PUBLISH_URL_TTL_SEC = 60 * 60;

export interface EngagementClient {
  /** Spec 16.3: tell Engagement a publication exists so comments on it are attributed. */
  attributePublication(input: {
    publicationId: string;
    organisationId: string;
    platform: string;
    platformPostId: string;
  }): Promise<void>;
}

export interface PublishingDeps {
  db: PrismaClient;
  publishers: PublisherRegistry;
  meta: MetaCredentialSource;
  keys: DataKeyProvider;
  oauth: (platform: OAuthPlatform) => OAuthClient;
  storage: AssetStorage;
  engagement: EngagementClient;
  logger: Logger;
  now: () => number;
}

export interface PublicationMetadata {
  connectionId?: string;
  title?: string;
  rawCaption?: string;
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

export function publicationMetadata(p: Pick<VideoPublication, 'metadata'>): PublicationMetadata {
  return p.metadata && typeof p.metadata === 'object' && !Array.isArray(p.metadata)
    ? (p.metadata as PublicationMetadata)
    : {};
}

/** Access token + account for a publication, from Studio connections or Engagement (Meta). */
export async function resolveCredentials(
  deps: PublishingDeps,
  publication: VideoPublication,
): Promise<{ accessToken: string; accountId: string }> {
  const platform = publication.platform as Platform;
  const rules = PLATFORM_RULES[platform];
  if (rules.credentials === 'meta') {
    const creds = await deps.meta.getCredentials({
      organisationId: publication.organisationId,
      platform: rules.connectionPlatform as 'instagram' | 'facebook',
      platformAccountId: publication.platformAccountId,
    });
    return { accessToken: creds.accessToken, accountId: creds.accountId };
  }
  const connectionId = publicationMetadata(publication).connectionId;
  const connection = connectionId
    ? await deps.db.platformConnection.findFirst({
        where: { id: connectionId, organisationId: publication.organisationId },
      })
    : null;
  if (!connection)
    throw new PlatformError(
      platform,
      'needs_reconnect',
      'The connected account no longer exists',
      false,
    );
  const accessToken = await getAccessToken(
    { db: deps.db, keys: deps.keys, oauth: deps.oauth, now: deps.now },
    connection,
  );
  return { accessToken, accountId: connection.platformAccountId };
}

/** Lazily-read render bytes for chunked uploads. */
export async function videoSource(
  deps: Pick<PublishingDeps, 'storage'>,
  render: VideoRender,
): Promise<VideoSource> {
  const sizeBytes = await deps.storage.size(render.s3Bucket, render.s3Key);
  if (sizeBytes <= 0) throw new NotFoundError('Render file is empty or missing');
  return {
    sizeBytes,
    contentType: 'video/mp4',
    durationSec: render.durationSec,
    aspectRatio: render.aspectRatio as VideoSource['aspectRatio'],
    signedUrl: await deps.storage.signedUrl(render.s3Bucket, render.s3Key, PUBLISH_URL_TTL_SEC),
    read: (start, end) => deps.storage.readRange(render.s3Bucket, render.s3Key, start, end),
  };
}

/**
 * Engagement attribution over HTTP (X-Service-Token). Best effort: a publication is not failed
 * because Engagement is down; the miss is logged for replay.
 */
export function createEngagementClient(input: {
  baseUrl: string | undefined;
  serviceToken: string | undefined;
  fetchImpl: typeof fetch;
  logger: Logger;
}): EngagementClient {
  return {
    async attributePublication(body) {
      if (!input.baseUrl || !input.serviceToken) {
        input.logger.warn(
          { publicationId: body.publicationId },
          '[engagement] attribution skipped: ENGAGEMENT_INTERNAL_URL or service token not set',
        );
        return;
      }
      try {
        const res = await input.fetchImpl(
          `${input.baseUrl.replace(/\/$/, '')}/api/engagement/internal/publications/attribute`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-service-token': input.serviceToken },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!res.ok)
          input.logger.error(
            { status: res.status, publication: body },
            '[engagement] attribution rejected',
          );
      } catch (err) {
        input.logger.error({ err, publication: body }, '[engagement] attribution failed');
      }
    },
  };
}
