import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { KillSwitch } from '../kill-switch';
import type { CircuitBreaker } from '../providers/circuit-breaker';
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
import type { JobQueue } from '../queue/enqueue';
import type { AssetStorage } from '../storage';
import type { Notifier } from '../notifications/notifier';
import type { MediaInspector } from './media-probe';
import type { RenderMastering } from './mastering';
import type { AllowedCorpusBucket } from '../library/corpus-source';

// Everything a pipeline processor needs, injected so processors are testable without Redis,
// real providers or ffmpeg.

export interface PipelineConfig {
  assetsBucket: string;
  rendersBucket: string;
  /** Voice used when the brand kit has none (spec 5.5 "pre-selected ElevenLabs voices"). */
  defaultVoiceId?: string;
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
   * 13.25: public https origin Hive posts async moderation results to
   * (STUDIO_PUBLIC_CALLBACK_BASE_URL). Absent = renders > 90 s fail the content-safety check.
   */
  hiveCallbackBaseUrl?: string;
  /** 13.25: how long to wait for a Hive callback before failing closed (default 2 h). */
  hiveAsyncTimeoutMs?: number;
}

export interface PipelineDeps {
  db: PrismaClient;
  registry: ProviderRegistry;
  breaker: CircuitBreaker;
  killSwitch: KillSwitch;
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
  /** 13.26 loudness normalisation + H.264 re-encode after compose; absent = not mastered. */
  mastering?: RenderMastering;
  /** HTTP client for downloading provider outputs. */
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
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
