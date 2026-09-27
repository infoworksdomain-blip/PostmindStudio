import type { PrismaClient } from '@prisma/client';
import { requireEnv } from '../../env';
import { auditLog } from '../../audit';
import { logger } from '../../logger';
import { lazyDataKeyProvider } from '../crypto/envelope';
import { unavailableMetaCredentials } from '../platforms/meta';
import { oauthClientFromEnv } from '../platforms/oauth';
import { createEngagementClient } from '../platforms/publishing';
import { createPublisherRegistry } from '../platforms/registry';
import { createKillSwitch, createPrismaFlagStore } from '../kill-switch';
import { createPrismaBudgetChecker, orgProviderDailyCapFromEnv } from '../providers/budget';
import { getCircuitBreaker } from '../providers/circuit-breaker';
import { getProviderRegistry } from '../providers/default-registry';
import { createPrismaProviderJobRepository } from '../providers/job-repository';
import type { JobQueue } from '../queue/enqueue';
import { assetsBucket, getAssetStorage } from '../storage';
import { DEFAULT_PIPELINE_TIMING, type PipelineDeps } from './deps';
import { createFfmpegInspector } from './media-probe';

// Production wiring for pipeline processors (workers and scripts).

export function createPipelineDeps(input: { db: PrismaClient; queue: JobQueue }): PipelineDeps {
  const breaker = getCircuitBreaker();
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const storage = getAssetStorage();
  const killSwitch = createKillSwitch({ store: createPrismaFlagStore(input.db) });
  return {
    db: input.db,
    registry: getProviderRegistry(),
    breaker,
    killSwitch,
    budget: createPrismaBudgetChecker(input.db, {
      orgProviderDailyCapPence: orgProviderDailyCapFromEnv(),
    }),
    tracking: { repo: createPrismaProviderJobRepository(input.db), killSwitch, breaker },
    queue: input.queue,
    storage,
    media: createFfmpegInspector(),
    logger,
    config: {
      assetsBucket: assetsBucket(),
      rendersBucket: requireEnv('S3_BUCKET_RENDERS'),
      defaultVoiceId: process.env.ELEVENLABS_DEFAULT_VOICE_ID?.trim() || undefined,
      ...DEFAULT_PIPELINE_TIMING,
    },
    fetch: globalThis.fetch,
    audit: auditLog,
    publishing: {
      db: input.db,
      publishers: createPublisherRegistry({
        fetchImpl: globalThis.fetch,
        sleep,
        now: Date.now,
        graphVersion: process.env.META_GRAPH_API_VERSION?.trim() || undefined,
      }),
      meta: unavailableMetaCredentials,
      keys: lazyDataKeyProvider(),
      oauth: (platform) => oauthClientFromEnv(platform),
      storage,
      engagement: createEngagementClient({
        baseUrl: process.env.ENGAGEMENT_INTERNAL_URL,
        serviceToken: process.env.POSTMIND_SERVICE_TOKEN,
        fetchImpl: globalThis.fetch,
        logger,
      }),
      logger,
      now: Date.now,
    },
    now: Date.now,
    sleep,
  };
}
