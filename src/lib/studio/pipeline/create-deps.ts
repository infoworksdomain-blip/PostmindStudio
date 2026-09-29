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
import { triggerFieldsEnabled, withTriggerFields } from '../core/engagement-trigger';
import { createBrowserlessRenderer } from '../scan/crawl';
import { headlessRendererFromEnv } from '../scan/headless-render';
import { guardedFetch } from '../scan/safe-fetch';
import { createPublisherRegistry } from '../platforms/registry';
import { createKillSwitch, createPrismaFlagStore } from '../kill-switch';
import { costCapsFromEnv } from '../cost/caps';
import { createCostGuard } from '../cost/guard';
import { createOrgCapOverrideLookup } from '../cost/org-overrides';
import { billingPipelineDepsFromEnv } from '../billing/wiring';
import { createNotifier } from '../notifications/notifier';
import { createPreferenceLookup } from '../notifications/preference-lookup';
import { getMetrics } from '../observability/metrics';
import { createPrismaBudgetChecker } from '../providers/budget';
import {
  createBreakerRedisClient,
  getSharedCircuitBreaker,
} from '../providers/circuit-breaker-redis';
import { providerRateLimiterFromEnv } from '../providers/provider-rate';
import { redisConnectionFromEnv } from '../queue/redis';
import { getProviderRegistry } from '../providers/default-registry';
import { createByocRegistryResolver } from '../providers/byoc-registry';
import { createPrismaProviderJobRepository } from '../providers/job-repository';
import type { JobQueue } from '../queue/enqueue';
import { assetsBucket, getAssetStorage } from '../storage';
import { DEFAULT_PIPELINE_TIMING, type PipelineDeps } from './deps';
import { createFfmpegInspector } from './media-probe';
import { parseCallbackBaseUrl, parseHiveTimeoutMs } from './content-safety-async';
import { createFfmpegMastering } from './mastering';
import { parseMusicMinTier } from './music';
import { createProviderRatings, providerRatingsEnabled } from '../services/provider-ratings';
import { parseCorpusBuckets } from '../library/corpus-source';
import { parseStockVoices } from './voice-fit';

// Production wiring for pipeline processors (workers and scripts).

export function createPipelineDeps(input: { db: PrismaClient; queue: JobQueue }): PipelineDeps {
  const breaker = getSharedCircuitBreaker();
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const storage = getAssetStorage();
  const keys = lazyDataKeyProvider();
  const killSwitch = createKillSwitch({ store: createPrismaFlagStore(input.db) });
  const caps = costCapsFromEnv();
  // Phase 18 Track C: billing access at job start + top-up / trial cost-cap adjustments.
  const billing = billingPipelineDepsFromEnv(input.db);
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
    adjustments: billing.adjustments,
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
    // P7: per-business provider ratings reorder the router's candidates (STUDIO_PROVIDER_RATINGS).
    ...(providerRatingsEnabled(process.env.STUDIO_PROVIDER_RATINGS) && {
      providerRatings: createProviderRatings({ db: input.db, now: Date.now }),
    }),
    // P1 BYOC: Enterprise organisations' own provider keys (undefined = platform registry).
    registryFor: createByocRegistryResolver({
      db: input.db,
      keys,
      platformRegistry: getProviderRegistry(),
      now: Date.now,
    }),
    queue: input.queue,
    storage,
    media: createFfmpegInspector(),
    mastering: createFfmpegMastering(),
    // 15.C3: per-(organisation, provider) rate windows from STUDIO_PROVIDER_RATE_<ID>.
    providerRates: providerRateLimiterFromEnv(
      process.env,
      () => createBreakerRedisClient(redisConnectionFromEnv()),
      logger,
    ),
    logger,
    config: {
      assetsBucket: assetsBucket(),
      rendersBucket: requireEnv('S3_BUCKET_RENDERS'),
      defaultVoiceId: process.env.ELEVENLABS_DEFAULT_VOICE_ID?.trim() || undefined,
      stockVoices: parseStockVoices(process.env.STUDIO_STOCK_VOICES),
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
      thumbnailsBucket: process.env.S3_BUCKET_THUMBNAILS?.trim() || undefined,
      keys,
      oauth: (platform) => oauthClientFromEnv(platform),
      storage,
      // 15.W5: ON_VIDEO_PUBLISHED trigger fields, only with STUDIO_ENGAGEMENT_TRIGGER_FIELDS=true.
      engagement: withTriggerFields(
        createEngagementClient({
          baseUrl: process.env.ENGAGEMENT_INTERNAL_URL,
          serviceToken: process.env.POSTMIND_SERVICE_TOKEN,
          fetchImpl: globalThis.fetch,
          logger,
        }),
        { db: input.db, logger, enabled: triggerFieldsEnabled() },
      ),
      logger,
      now: Date.now,
    },
    now: Date.now,
    sleep,
    billingAccess: billing.billingAccess,
  };
}
