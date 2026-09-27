import type { PrismaClient } from '@prisma/client';
import { requireEnv } from '../../env';
import { auditLog } from '../../audit';
import { logger } from '../../logger';
import { lazyDataKeyProvider } from '../crypto/envelope';
import { createStoredMetaCredentials } from '../platforms/meta-credentials';
import { oauthClientFromEnv } from '../platforms/oauth';
import { createMetricsRegistry } from '../analytics/fetchers';
import { stockSourcesFromEnv } from '../images/stock';
import { createEngagementClient } from '../platforms/publishing';
import { createBrowserlessRenderer } from '../scan/crawl';
import { headlessRendererFromEnv } from '../scan/headless-render';
import { guardedFetch } from '../scan/safe-fetch';
import { createPublisherRegistry } from '../platforms/registry';
import { createKillSwitch, createPrismaFlagStore } from '../kill-switch';
import { costCapsFromEnv } from '../cost/caps';
import { createCostGuard } from '../cost/guard';
import { createOrgCapOverrideLookup } from '../cost/org-overrides';
import { createNotifier } from '../notifications/notifier';
import { createPreferenceLookup } from '../notifications/preference-lookup';
import { getMetrics } from '../observability/metrics';
import { createPrismaBudgetChecker } from '../providers/budget';
import { getSharedCircuitBreaker } from '../providers/circuit-breaker-redis';
import { getProviderRegistry } from '../providers/default-registry';
import { createPrismaProviderJobRepository } from '../providers/job-repository';
import type { JobQueue } from '../queue/enqueue';
import { assetsBucket, getAssetStorage } from '../storage';
import { DEFAULT_PIPELINE_TIMING, type PipelineDeps } from './deps';
import { createFfmpegInspector } from './media-probe';
import { parseCallbackBaseUrl, parseHiveTimeoutMs } from './content-safety-async';
import { createFfmpegMastering } from './mastering';
import { parseMusicMinTier } from './music';
import { parseCorpusBuckets } from '../library/corpus-source';

// Production wiring for pipeline processors (workers and scripts).

export function createPipelineDeps(input: { db: PrismaClient; queue: JobQueue }): PipelineDeps {
  const breaker = getSharedCircuitBreaker();
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const storage = getAssetStorage();
  const keys = lazyDataKeyProvider();
  const killSwitch = createKillSwitch({ store: createPrismaFlagStore(input.db) });
  const caps = costCapsFromEnv();
  // 13.24: in-app suppression and email recipients follow notification preferences.
  const preferences = createPreferenceLookup(input.db);
  const notifier = createNotifier({
    db: input.db,
    logger,
    preferences,
    emailPreferences: preferences,
  });
  const guard = createCostGuard({
    db: input.db,
    caps,
    notifier,
    audit: auditLog,
    logger,
    metrics: getMetrics(),
    overrides: createOrgCapOverrideLookup(input.db),
  });
  return {
    db: input.db,
    registry: getProviderRegistry(),
    breaker,
    killSwitch,
    budget: createPrismaBudgetChecker(input.db, {
      orgProviderDailyCapPence: caps.orgProviderDailyPence,
      guard,
    }),
    tracking: { repo: createPrismaProviderJobRepository(input.db), killSwitch, breaker },
    queue: input.queue,
    storage,
    media: createFfmpegInspector(),
    mastering: createFfmpegMastering(),
    logger,
    config: {
      assetsBucket: assetsBucket(),
      rendersBucket: requireEnv('S3_BUCKET_RENDERS'),
      defaultVoiceId: process.env.ELEVENLABS_DEFAULT_VOICE_ID?.trim() || undefined,
      fontsBaseUrl: process.env.STUDIO_FONTS_BASE_URL?.trim() || undefined,
      musicMinTier: parseMusicMinTier(process.env.STUDIO_MUSIC_MIN_TIER),
      libraryBucket: process.env.S3_BUCKET_LIBRARY?.trim() || undefined,
      corpusS3Buckets: parseCorpusBuckets(process.env.STUDIO_CORPUS_S3_BUCKETS),
      hiveCallbackBaseUrl: parseCallbackBaseUrl(process.env.STUDIO_PUBLIC_CALLBACK_BASE_URL),
      hiveAsyncTimeoutMs: parseHiveTimeoutMs(process.env.HIVE_ASYNC_TIMEOUT_MIN),
      ...DEFAULT_PIPELINE_TIMING,
    },
    fetch: globalThis.fetch,
    audit: auditLog,
    notifier,
    metrics: createMetricsRegistry({
      fetchImpl: globalThis.fetch,
      linkedInEnabled: process.env.LINKEDIN_POST_ANALYTICS === 'enabled',
      graphVersion: process.env.META_GRAPH_API_VERSION?.trim() || undefined,
    }),
    scan: {
      pageFetch: guardedFetch,
      renderer: process.env.BROWSERLESS_API_KEY?.trim()
        ? createBrowserlessRenderer({
            token: process.env.BROWSERLESS_API_KEY.trim(),
            fetchImpl: globalThis.fetch,
          })
        : undefined,
      headless: headlessRendererFromEnv(process.env, globalThis.fetch),
      stock: () => stockSourcesFromEnv({ fetchImpl: globalThis.fetch, now: Date.now }),
    },
    publishing: {
      db: input.db,
      publishers: createPublisherRegistry({
        fetchImpl: globalThis.fetch,
        sleep,
        now: Date.now,
        graphVersion: process.env.META_GRAPH_API_VERSION?.trim() || undefined,
      }),
      meta: createStoredMetaCredentials({ db: input.db, keys, now: Date.now }),
      keys,
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
