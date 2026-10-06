import type { EmailSendConfig } from '../../email/config';
import type { EmailTransport } from '../../email/resend-client';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { KillSwitch } from '../kill-switch';
import type { FeatureGate } from '../services/features';
import type { CircuitBreaker } from '../providers/circuit-breaker';
import type { ProviderConcurrencyLimiter } from '../providers/provider-concurrency';
import type { ProviderRateLimiter } from '../providers/provider-rate';
import type { ProviderRegistry } from '../providers/registry';
import type { BudgetChecker, PlanTier } from '../providers/router';
import type { TrackingDeps } from '../providers/tracked';
import type { AuditEntry } from '../../audit';
import type { MetricsRegistry } from '../analytics/fetchers';
import type { StockImageSource } from '../images/stock';
import type { PublishingDeps } from '../platforms/publishing';
import type { PageRenderer } from '../scan/crawl';
import type { HeadlessRenderer } from '../scan/headless-render';
import type { CoreChannelDirectory } from '../core/channel-directory';
import type { CalendarShadowClient } from '../core/calendar-shadow-client';
import type { CoreOrganisationDirectory } from '../core/organisation-directory';
import type { UsageReporter } from '../core/usage-reporter';
import type { JobQueue } from '../queue/enqueue';
import type { AssetStorage } from '../storage';
import type { Notifier } from '../notifications/notifier';
import type { MediaInspector } from './media-probe';
import type { RenderMastering } from './mastering';
import type { AllowedCorpusBucket } from '../library/corpus-source';
import type { LibraryCache } from '../library/cache';
import type { ThumbnailComposer } from '../services/thumbnail-composer';
import type { BillingAccessLookup } from '../billing/job-access';
import type { BillingJobDeps } from '../billing/wiring';
import type { AuthMailer } from '../../email/auth-mailer';

// Everything a pipeline processor needs, injected so processors are testable without Redis,
// real providers or ffmpeg.

export interface PipelineConfig {
  assetsBucket: string;
  rendersBucket: string;
  /** Voice used when the brand kit has none (spec 5.5 "pre-selected ElevenLabs voices"). */
  defaultVoiceId?: string;
  /** 15.B3: tone-matched stock voices (STUDIO_STOCK_VOICES; pipeline/voice-fit.ts). */
  stockVoices?: ReadonlyMap<string, string>;
  /** Poll cadence for async providers (Runway asks for ≥5s). */
  providerPollIntervalMs: number;
  /** Give up on a single provider job after this long. */
  providerTimeoutMs: number;
  /** Where overlay fonts are hosted as <FamilyNoSpaces>.ttf (Shotstack has no system fonts). */
  fontsBaseUrl?: string;
  /** Lowest plan tier that gets a generated music track (STUDIO_MUSIC_MIN_TIER; music.ts). */
  musicMinTier?: PlanTier;
  /** Video library corpus bucket (S3_BUCKET_LIBRARY); Feature A ingestion only. */
  libraryBucket?: string;
  /** STUDIO_CORPUS_S3_BUCKETS: buckets (or bucket/prefix) s3:// corpus sources may come from. */
  corpusS3Buckets?: AllowedCorpusBucket[];
  /**
   * 21.4c: check UGC actor clips for burned-in text (ugc/clip-text-guard.ts). Absent = the
   * STUDIO_CLIP_TEXT_GUARD environment value (unset = on; "false" = off).
   */
  clipTextGuard?: boolean;
}

export interface PipelineDeps {
  db: PrismaClient;
  registry: ProviderRegistry;
  breaker: CircuitBreaker;
  killSwitch: KillSwitch;
  /** 15.D1 feature flags; absent = the process-wide gate for `db` (30 s cache). */
  features?: FeatureGate;
  budget: BudgetChecker;
  tracking: TrackingDeps;
  queue: JobQueue;
  storage: AssetStorage;
  media: MediaInspector;
  logger: Logger;
  config: PipelineConfig;
  /** Feature D (Phase 6): website scans and the image library. */
  scan: ScanDeps;
  /** Per-platform metrics readers for analytics polling (Phase 11). */
  metrics: MetricsRegistry;
  /** Social publishing (Phase 5): publishers, credentials, Engagement attribution. */
  publishing: PublishingDeps;
  /** Audit entries for significant mutations (publications). */
  audit: (entry: AuditEntry) => void;
  /** Spec 14.4 notifications; absent = built from db/logger/env (notifications/notifier.ts). */
  notifier?: Notifier;
  /** Core's channel list for the daily Meta reconciliation (13.35); absent = pending (skipped). */
  coreChannels?: CoreChannelDirectory;
  /**
   * 15.W2–W4 Core clients (usage events, calendar shadows, organisation existence); absent =
   * pending (the jobs keep their outbox rows pending_setup / skip until Core ships the APIs).
   */
  core?: CoreSyncClients;
  /** 15.A3 thumbnail rendering (FFmpeg); absent = built from FFMPEG_PATH on first use. */
  thumbnails?: ThumbnailComposer;
  /** 13.26 loudness normalisation + H.264 re-encode after compose; absent = not mastered. */
  mastering?: RenderMastering;
  /**
   * 20.15: the shared library read cache; corpus workers bump its version when the catalogue
   * changes. Absent = no cache (nothing to invalidate).
   */
  libraryCache?: LibraryCache;
  /** 15.C3 per-(organisation, provider) rate windows; absent = no Studio-side limits. */
  providerRates?: ProviderRateLimiter;
  /** 20.29 per-provider in-flight caps (Seedance 3, Kling 20…); absent = no Studio-side caps. */
  providerConcurrency?: ProviderConcurrencyLimiter;
  /**
   * 20.29 STUDIO_PROVIDER_OVERFLOW: when a provider's account is full, 'queue' (default) waits for
   * a slot (cheapest); 'failover' tries the next provider for the capability first (faster under a
   * burst, dearer: e.g. Kling instead of Seedance) and waits only when every candidate is full.
   */
  providerOverflow?: 'queue' | 'failover';
  /**
   * P1 BYOC: the organisation's own-key registry (Enterprise, STUDIO_BYOC_ENABLED); absent or
   * undefined for an organisation = the platform registry above.
   */
  registryFor?: (scope: ProviderScope) => Promise<ProviderRegistry | undefined>;
  /** P7: per-business provider scores (0–1) the router prefers within a tier's candidates. */
  providerRatings?: { scoresFor(scope: ProviderScope): Promise<Readonly<Record<string, number>>> };
  /**
   * Phase 18 §2.8 email delivery (send-email job); absent = Resend + config from env on first use
   * (lib/email/config.ts).
   */
  email?: EmailDeliveryDeps;
  /** HTTP client for downloading provider outputs. */
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /**
   * Phase 18 §P.3 (Track C): the organisation's billing access, checked at job start
   * (billing/job-access.ts); absent = not checked (core mode, tests).
   */
  billingAccess?: BillingAccessLookup;
  /** Phase 18 (Track C): Stripe sweeper + nightly reconcile; absent = built from env on use. */
  billingJobs?: BillingJobDeps;
  /**
   * Phase 18 §2.8: transactional email sent by worker jobs (billing notices from the Stripe
   * sweeper, the cancelled-organisation retention job). Absent = the email is skipped and logged.
   */
  mailer?: AuthMailer;
}

/** Phase 18 §2.8: what the send-email job needs (tests inject a fake transport). */
export interface EmailDeliveryDeps {
  transport: EmailTransport;
  config: EmailSendConfig;
}

/** 15.W2–W4: PostMind Core integrations the scheduled Core-sync jobs use. */
export interface CoreSyncClients {
  usage?: UsageReporter;
  calendar?: CalendarShadowClient;
  organisations?: CoreOrganisationDirectory;
  /**
   * Phase 18 §1 row 12: 'local' = standalone billing (Stripe tiers): usage rows are recorded with
   * state `local` and never sent. Absent / 'outbox' = rows wait for Core (pending_setup).
   */
  usageRecording?: 'outbox' | 'local';
  /** Phase 18 §1 row 13: false = no Core calendar, so no shadow rows are written. Absent = on. */
  calendarShadows?: boolean;
  /**
   * Phase 18 §1 row 10: false = Studio owns the Meta login (STUDIO_META_CONNECT=studio), so there
   * is no Core channel list to reconcile against. Absent = on (waits for Core list-channels).
   */
  channelReconciliation?: boolean;
}

/** Who a provider call is for (Phase 15: BYOC registry and provider ratings are per org). */
export interface ProviderScope {
  organisationId: string;
  projectId?: string;
}

export interface ScanDeps {
  /** fetch for attacker-supplied URLs: must refuse non-public addresses (scan/safe-fetch.ts). */
  pageFetch: typeof fetch;
  /** JS-rendering fallback for SPA sites (Browserless), when configured. */
  renderer?: PageRenderer;
  /**
   * 13.37 browser-render fallback for blocked homepages (STUDIO_HEADLESS_RENDER_URL). Absent or
   * unconfigured = the scan fails as before and the user enters the profile manually.
   */
  headless?: HeadlessRenderer;
  /** Stock image sources, resolved lazily so a missing key only fails the stock layer. */
  stock: () => { primary: StockImageSource[]; fallback: StockImageSource[] };
  random?: () => number;
  /** 13.11 DNS TXT lookups for domain verification; absent = node:dns resolveTxt. */
  resolveTxt?: (hostname: string) => Promise<string[][]>;
}

export const DEFAULT_PIPELINE_TIMING = {
  providerPollIntervalMs: 5_000,
  providerTimeoutMs: 15 * 60_000,
} as const;
