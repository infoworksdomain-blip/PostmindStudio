import { ProviderError } from '../../errors';
import { httpJson } from './http';
import type {
  ContentSafetyRequest,
  ProviderAdapter,
  ProviderCapability,
  ProviderPollResult,
  ProviderRequest,
  ProviderSubmitResult,
} from './interface';
import { usdToPence } from './pricing';
import { providerError } from './provider-errors';
import { SyncJobStore } from './sync-jobs';

// Hive Visual Moderation (Layer 8 content safety, spec 13.2). Contract from docs.thehive.ai
// (read 2026-09-27):
//   POST https://api.thehive.ai/api/v2/task/sync, header `authorization: token <key>`,
//   form field `url`; response status[].response.output[] = [{ time, classes:[{class, score}] }]
//   sampled at 1 frame/second.
// Only the SYNC endpoint is used: it accepts segments up to 90s. Hive's async API requires a
// public callback_url (not built yet), so longer videos are rejected here and the quality gate
// fails closed for them. The adapter reports per-class maxima; policy lives in the pipeline.

export const PROVIDER_ID = 'hive';
export const SYNC_URL = 'https://api.thehive.ai/api/v2/task/sync';
export const MAX_SYNC_DURATION_SEC = 90;
/** thehive.ai/models/hive/visual-moderation: "$3.00 / 1000 images" (frames at 1 fps). */
const USD_PER_FRAME = 0.003;
const TIMEOUT_MS = 120_000;
const MAX_FLAGGED_FRAMES = 50;
/** Scores at or above this are listed as flagged frames (Hive suggests >0.90 as a start). */
const FLAG_REPORT_THRESHOLD = 0.5;

interface HiveClass {
  class: string;
  score: number;
}

interface HiveResponse {
  status?: Array<{
    status?: { code?: string; message?: string };
    response?: { output?: Array<{ time?: number; classes?: HiveClass[] }> };
  }>;
}

export interface HiveAdapterOptions {
  apiKey: string;
  usdToGbpRate: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface ContentSafetyScan {
  framesAnalysed: number;
  maxScores: Record<string, number>;
  flaggedFrames: Array<{ time: number; class: string; score: number }>;
}

export function summariseHiveOutput(body: HiveResponse): ContentSafetyScan {
  const frames = body.status?.flatMap((s) => s.response?.output ?? []) ?? [];
  const maxScores: Record<string, number> = {};
  const flagged: ContentSafetyScan['flaggedFrames'] = [];
  for (const frame of frames) {
    for (const c of frame.classes ?? []) {
      maxScores[c.class] = Math.max(maxScores[c.class] ?? 0, c.score);
      if (c.score >= FLAG_REPORT_THRESHOLD && !c.class.startsWith('no_')) {
        flagged.push({ time: frame.time ?? 0, class: c.class, score: c.score });
      }
    }
  }
  flagged.sort((a, b) => b.score - a.score);
  return {
    framesAnalysed: frames.length,
    maxScores,
    flaggedFrames: flagged.slice(0, MAX_FLAGGED_FRAMES),
  };
}

export class HiveAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[] = ['content_safety'];
  readonly typicalLatencySec = 30;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly results: SyncJobStore;

  constructor(private readonly options: HiveAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.results = new SyncJobStore(PROVIDER_ID, this.now);
  }

  estimateCostPence(request: ProviderRequest): number {
    if (request.capability !== 'content_safety') return 0;
    return usdToPence(Math.ceil(request.durationSec) * USD_PER_FRAME, this.options.usdToGbpRate);
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    if (request.capability !== 'content_safety') {
      throw this.invalid(`Hive adapter does not support ${request.capability}`);
    }
    const result = await this.scan(request);
    const costPence =
      (result.output?.metadata as { costPence?: number } | undefined)?.costPence ?? 0;
    return {
      providerJobId: this.results.put(result),
      estimatedCostPence: costPence,
      estimatedReadyAt: new Date(this.now()),
    };
  }

  async poll(providerJobId: string): Promise<ProviderPollResult> {
    return this.results.get(providerJobId);
  }

  async cancel(providerJobId: string): Promise<void> {
    this.results.delete(providerJobId);
  }

  /** Hive documents no free health endpoint; every task is billed. Report configuration only. */
  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    return this.options.apiKey
      ? { healthy: true, reason: 'not probed: Hive has no unbilled health endpoint' }
      : { healthy: false, reason: 'auth: HIVE_API_KEY not set' };
  }

  private async scan(request: ContentSafetyRequest): Promise<ProviderPollResult> {
    if (request.durationSec > MAX_SYNC_DURATION_SEC) {
      throw this.invalid(
        `Video is ${request.durationSec}s; Hive sync moderation accepts up to ${MAX_SYNC_DURATION_SEC}s`,
      );
    }
    const form = new FormData();
    form.append('url', request.mediaUrl);
    const { body } = await httpJson<HiveResponse>(
      SYNC_URL,
      { method: 'POST', headers: { authorization: `token ${this.options.apiKey}` }, body: form },
      {
        providerId: PROVIDER_ID,
        fetchImpl: this.fetchImpl,
        timeoutMs: TIMEOUT_MS,
        errorMessage: (b) =>
          typeof b === 'object' && b && 'message' in b
            ? String((b as { message: unknown }).message)
            : undefined,
      },
    );
    const taskStatus = body.status?.[0]?.status;
    if (taskStatus?.code && taskStatus.code !== '0') {
      return {
        state: 'failed',
        error: {
          class: 'unknown',
          message: `Hive task status ${taskStatus.code}: ${taskStatus.message ?? ''}`,
          retryable: true,
        },
      };
    }
    const scan = summariseHiveOutput(body);
    if (scan.framesAnalysed === 0) {
      return {
        state: 'failed',
        error: { class: 'unknown', message: 'Hive returned no frames', retryable: true },
      };
    }
    const costPence = usdToPence(scan.framesAnalysed * USD_PER_FRAME, this.options.usdToGbpRate);
    return { state: 'succeeded', output: { metadata: { ...scan, costPence } } };
  }

  private invalid(message: string): ProviderError {
    return providerError(PROVIDER_ID, { errorClass: 'invalid_request', retryable: false }, message);
  }
}
