import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { KillSwitch } from '../kill-switch';
import type { CircuitBreaker } from '../providers/circuit-breaker';
import type { ProviderRegistry } from '../providers/registry';
import type { BudgetChecker } from '../providers/router';
import type { TrackingDeps } from '../providers/tracked';
import type { AuditEntry } from '../../audit';
import type { StockImageSource } from '../images/stock';
import type { PublishingDeps } from '../platforms/publishing';
import type { PageRenderer } from '../scan/crawl';
import type { JobQueue } from '../queue/enqueue';
import type { AssetStorage } from '../storage';
import type { MediaInspector } from './media-probe';

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
  /** Social publishing (Phase 5): publishers, credentials, Engagement attribution. */
  publishing: PublishingDeps;
  /** Audit entries for significant mutations (publications). */
  audit: (entry: AuditEntry) => void;
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
  /** Stock image sources, resolved lazily so a missing key only fails the stock layer. */
  stock: () => { primary: StockImageSource[]; fallback: StockImageSource[] };
  random?: () => number;
}

export const DEFAULT_PIPELINE_TIMING = {
  providerPollIntervalMs: 5_000,
  providerTimeoutMs: 15 * 60_000,
} as const;
