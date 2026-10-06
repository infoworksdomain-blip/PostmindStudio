import type { PrismaClient } from '@prisma/client';
import { requireEnv } from '../../env';
import { auditLog } from '../../audit';
import { logger } from '../../logger';
import { lazyDataKeyProvider } from '../crypto/envelope';
import { createStoredMetaCredentials } from '../platforms/meta-credentials';
import { oauthClientFromEnv, oauthConfiguredFromEnv } from '../platforms/oauth';
import { createMetricsRegistry } from '../analytics/fetchers';
import { stockSourcesFromEnv } from '../images/stock';
import { stockCacheFromEnv } from '../images/stock-cache';
import { createEngagementClient } from '../platforms/publishing';
import { triggerFieldsEnabled, withTriggerFields } from '../core/engagement-trigger';
import { engagementEnabled, selectCoreSyncClients } from '../core/select';
import { studioModes } from '../../mode';
import { createBrowserlessRenderer } from '../scan/crawl';
import { headlessRendererFromEnv } from '../scan/headless-render';
import { guardedFetch } from '../scan/safe-fetch';
import { createPublisherRegistry } from '../platforms/registry';
import { createKillSwitch, createPrismaFlagStore } from '../kill-switch';
import { costCapsFromEnv } from '../cost/caps';
import { createCostGuard } from '../cost/guard';
import { createOrgCapOverrideLookup } from '../cost/org-overrides';
import { createEmailSender } from '../notifications/email';
import { mailerFromEnv } from '../../email/mailer';
import { billingPipelineDepsFromEnv } from '../billing/wiring';
import { createNotifier } from '../notifications/notifier';
import { createPreferenceLookup } from '../notifications/preference-lookup';
import { getMetrics } from '../observability/metrics';
import { createPrismaBudgetChecker } from '../providers/budget';
import {
  createBreakerRedisClient,
  getSharedCircuitBreaker,
} from '../providers/circuit-breaker-redis';
import {
  providerConcurrencyFromEnv,
  providerOverflowFromEnv,
} from '../providers/provider-concurrency';
import { providerRateLimiterFromEnv } from '../providers/provider-rate';
import { providerWakeFromEnv } from '../providers/provider-wake';
import { redisConnectionFromEnv } from '../queue/redis';
import { getProviderRegistry } from '../providers/default-registry';
import { createByocRegistryResolver } from '../providers/byoc-registry';
import { createPrismaProviderJobRepository } from '../providers/job-repository';
import type { JobQueue } from '../queue/enqueue';
import { fontsBaseUrlFromEnv } from '../fonts-host';
import { assetsBucket, getAssetStorage } from '../storage';
import { DEFAULT_PIPELINE_TIMING, type PipelineDeps } from './deps';
import { createFfmpegInspector } from './media-probe';
import { createFfmpegMastering } from './mastering';
import { parseMusicMinTier } from './music';
import { musicLibraryFromEnv } from './music-library';
import { createProviderRatings, providerRatingsEnabled } from '../services/provider-ratings';
import { parseCorpusBuckets } from '../library/corpus-source';
import {
  createLibraryCache,
  createLibraryCacheRedisClient,
  libraryCacheEnabled,
} from '../library/cache';
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
    // Phase 18 §2.8: Resend in standalone mode (outbox + send-email job), per STUDIO_EMAIL_PROVIDER.
    email: createEmailSender({ db: input.db, queue: input.queue, logger }),
  });
  // Phase 18 §2.12: Core / Engagement / Meta adapters chosen once from the mode (core/select.ts).
  const modes = studioModes();
  const studioMeta = modes.metaConnect === 'studio';
  // appsecret_proof only with Studio's own Meta app: Core's tokens belong to Core's app.
  const metaAppSecret = studioMeta ? process.env.META_APP_SECRET?.trim() || undefined : undefined;
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
    core: selectCoreSyncClients(modes, input.db),
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
    // Phase 18 §2.8: worker-sent transactional email (billing sync, cancelled-org retention).
    mailer: mailerFromEnv({ db: input.db, queue: input.queue, logger }),
    storage,
    media: createFfmpegInspector(),
    mastering: createFfmpegMastering(),
    // 20.15: shared library cache in Redis DB 3 (STUDIO_LIBRARY_CACHE=off disables it).
    ...(libraryCacheEnabled() && {
      libraryCache: createLibraryCache({
        client: createLibraryCacheRedisClient(redisConnectionFromEnv()),
        logger,
      }),
    }),
    // 15.C3: per-(organisation, provider) rate windows from STUDIO_PROVIDER_RATE_<ID>.
    providerRates: providerRateLimiterFromEnv(
      process.env,
      () => createBreakerRedisClient(redisConnectionFromEnv()),
      logger,
    ),
    // 20.29: in-flight caps per provider (STUDIO_PROVIDER_CONCURRENCY_<ID>; Seedance 3, Kling 20).
    providerConcurrency: providerConcurrencyFromEnv(
      process.env,
      () => createBreakerRedisClient(redisConnectionFromEnv()),
      logger,
    ),
    providerOverflow: providerOverflowFromEnv(process.env),
    // 23.1: Shotstack render callbacks wake the waiting compose job (Redis flags).
    providerWake: providerWakeFromEnv(
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
      // 20.7: STUDIO_FONTS_BASE_URL, else the fonts this app serves itself at APP_URL/fonts.
      fontsBaseUrl: fontsBaseUrlFromEnv(process.env),
      musicMinTier: parseMusicMinTier(process.env.STUDIO_MUSIC_MIN_TIER),
      musicLibrary: musicLibraryFromEnv(process.env),
      libraryBucket: process.env.S3_BUCKET_LIBRARY?.trim() || undefined,
      corpusS3Buckets: parseCorpusBuckets(process.env.STUDIO_CORPUS_S3_BUCKETS),
      ...DEFAULT_PIPELINE_TIMING,
    },
    fetch: globalThis.fetch,
    audit: auditLog,
    notifier,
    metrics: createMetricsRegistry({
      fetchImpl: globalThis.fetch,
      linkedInEnabled: process.env.LINKEDIN_POST_ANALYTICS === 'enabled',
      graphVersion: process.env.META_GRAPH_API_VERSION?.trim() || undefined,
      metaAppSecret,
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
      // 20.16: stock searches are cached 24 h (Pixabay's terms), in Redis when REDIS_URL is set.
      stock: () =>
        stockSourcesFromEnv({
          fetchImpl: globalThis.fetch,
          now: Date.now,
          cache: stockCacheFromEnv(
            process.env,
            () => createBreakerRedisClient(redisConnectionFromEnv()),
            logger,
          ),
        }),
    },
    publishing: {
      db: input.db,
      publishers: createPublisherRegistry({
        fetchImpl: globalThis.fetch,
        sleep,
        now: Date.now,
        graphVersion: process.env.META_GRAPH_API_VERSION?.trim() || undefined,
        appSecret: metaAppSecret,
      }),
      meta: createStoredMetaCredentials({
        db: input.db,
        keys,
        now: Date.now,
        reconnectIn: studioMeta ? 'studio' : 'core',
      }),
      thumbnailsBucket: process.env.S3_BUCKET_THUMBNAILS?.trim() || undefined,
      keys,
      oauth: (platform) => oauthClientFromEnv(platform),
      oauthConfigured: (platform) => oauthConfiguredFromEnv(platform),
      storage,
      // 15.W5: ON_VIDEO_PUBLISHED trigger fields, only with STUDIO_ENGAGEMENT_TRIGGER_FIELDS=true.
      // Phase 18: Engagement is optional; without ENGAGEMENT_INTERNAL_URL attribution is off
      // (a silent no-op, not a warning per publish).
      engagement: engagementEnabled()
        ? withTriggerFields(
            createEngagementClient({
              baseUrl: process.env.ENGAGEMENT_INTERNAL_URL,
              serviceToken: process.env.POSTMIND_SERVICE_TOKEN,
              fetchImpl: globalThis.fetch,
              logger,
            }),
            { db: input.db, logger, enabled: triggerFieldsEnabled() },
          )
        : { attributePublication: async () => undefined },
      logger,
      now: Date.now,
    },
    now: Date.now,
    sleep,
    billingAccess: billing.billingAccess,
  };
}
