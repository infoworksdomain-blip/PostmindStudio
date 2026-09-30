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
import { DEFAULT_HIVE_V3_MAX_FRAMES, type HiveApiVersion } from './hive-config';
import { summariseFrames, type ContentSafetyScan } from './hive-scan';
import { scanWithV3, v3FrameCount, type FrameGrabber } from './hive-v3';

export type { ContentSafetyScan } from './hive-scan';

// Hive Visual Moderation (Layer 8 content safety, spec 13.2).
//
// 20.6: two APIs. `apiVersion: 'v2'` (default; Enterprise project key, HIVE_API_KEY) is the
// contract below. `apiVersion: 'v3'` (self-serve Secret Key, HIVE_V3_SECRET_KEY) is hive-v3.ts:
// POST https://api.thehive.ai/api/v3/hive/visual-moderation with `authorization: Bearer`, always
// synchronous, videos up to 60 s, longer renders scanned as sampled frames. Which one the
// platform uses: providers/hive-config.ts (HIVE_API_VERSION). Both report the same per-class
// maxima (hive-scan.ts), so the policy in pipeline/quality-checks.ts is shared.
//
// V2 contract from docs.thehive.ai (read 2026-09-27):
//   POST https://api.thehive.ai/api/v2/task/sync, header `authorization: token <key>`,
//   form field `url`; response status[].response.output[] = [{ time, classes:[{class, score}] }]
//   sampled at 1 frame/second.
// Media up to 90 s use the SYNC endpoint. Longer renders (BACKLOG 13.25) use the ASYNC
// endpoint (docs.thehive.ai/reference/submit-a-task-asynchronously and
// /reference/authentication, read 2026-09-27):
//   POST https://api.thehive.ai/api/v2/task/async, same header, form fields `url` and
//   `callback_url`; the response acknowledges the task with its id (`task_id` / `id`) and
//   "Once the task is completed, Hive will send a POST request to the provided callback_url
//   containing the completed task's results" — the same task object as the sync response.
// Hive documents NO signature on that callback, so the pipeline authenticates it with an
// unguessable per-task token in the callback URL (pipeline/content-safety-async.ts). The
// callback body is stored by the webhook; poll() reads it through `asyncResults` and reports
// `running` until it arrives. Hive documents no cancel endpoint: cancel() of an async task is a
// no-op (the tracked reservation is still released). The adapter reports per-class maxima;
// policy lives in the pipeline.
//
// 15.C5 languages (read 2026-09-28): this adapter runs VISUAL moderation only — its classes are
// about the pictures, so they are language-independent; on-screen text in any language is NOT
// read or classified here. Hive's separate OCR Moderation product lists English, Spanish,
// French, German, Italian, Mandarin, Russian, Portuguese, Arabic, Korean, Japanese and Hindi
// (https://docs.thehive.ai/docs/ocr-text-recognition-moderation), i.e. all Studio languages,
// and Hive Text Moderation states "~30 languages"
// (https://docs.thehive.ai/docs/classification-text); neither is integrated. Spoken and written
// words of non-English scripts are screened only by Studio's own script-safety pass (Layer 2).

export const PROVIDER_ID = 'hive';
export const SYNC_URL = 'https://api.thehive.ai/api/v2/task/sync';
export const ASYNC_URL = 'https://api.thehive.ai/api/v2/task/async';
/** V2 sync limit; longer renders use V2's async API (V3 has none: hive-v3.ts). */
export const MAX_SYNC_DURATION_SEC = 90;
/** thehive.ai/models/hive/visual-moderation: "$3.00 / 1000 images" (frames at 1 fps). */
const USD_PER_FRAME = 0.003;
const TIMEOUT_MS = 120_000;

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
  /** V2: the project API key. V3: the Secret Key. */
  apiKey: string;
  /** 20.6: which Hive API `apiKey` belongs to (default v2). */
  apiVersion?: HiveApiVersion;
  /** V3 only: frames sampled from renders over 60 s (HIVE_V3_MAX_FRAMES, default 10). */
  maxFrames?: number;
  /** V3 only: ffmpeg frame grab for renders over 60 s (pipeline/media-probe.ts frameJpeg). */
  frameJpeg?: FrameGrabber;
  usdToGbpRate: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * Reads the stored callback body of an async task by Hive task id; null/undefined while the
   * callback has not arrived. Without it, async tasks cannot be settled (poll reports failed).
   */
  asyncResults?: (hiveTaskId: string) => Promise<unknown>;
}

interface HiveAsyncAck {
  id?: string;
  task_id?: string;
  task_ids?: string[];
  message?: string;
}

/** A V2 task object (sync response or async callback body) → per-class maxima. */
export function summariseHiveOutput(body: HiveResponse): ContentSafetyScan {
  const frames = body.status?.flatMap((s) => s.response?.output ?? []) ?? [];
  return summariseFrames(
    frames.map((frame) => ({ time: frame.time ?? 0, classes: frame.classes ?? [] })),
  );
}

/** SyncJobStore ids are `hive_<uuid>`; Hive's own task ids (async) never carry that prefix. */
function isSyncJobId(id: string): boolean {
  return id.startsWith(`${PROVIDER_ID}_`);
}

export class HiveAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[] = ['content_safety'];
  readonly typicalLatencySec = 30;
  readonly apiVersion: HiveApiVersion;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly results: SyncJobStore;
  private readonly maxFrames: number;

  constructor(private readonly options: HiveAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.results = new SyncJobStore(PROVIDER_ID, this.now);
    this.apiVersion = options.apiVersion ?? 'v2';
    this.maxFrames = options.maxFrames ?? DEFAULT_HIVE_V3_MAX_FRAMES;
  }

  estimateCostPence(request: ProviderRequest): number {
    if (request.capability !== 'content_safety') return 0;
    const frames =
      this.apiVersion === 'v3'
        ? v3FrameCount(request.durationSec, this.maxFrames)
        : Math.ceil(request.durationSec);
    return usdToPence(frames * USD_PER_FRAME, this.options.usdToGbpRate);
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    if (request.capability !== 'content_safety') {
      throw this.invalid(`Hive adapter does not support ${request.capability}`);
    }
    const v3 = this.apiVersion === 'v3';
    if (!v3 && request.durationSec > MAX_SYNC_DURATION_SEC) return this.submitAsync(request);
    const result = v3 ? await this.scanV3(request) : await this.scan(request);
    const costPence =
      (result.output?.metadata as { costPence?: number } | undefined)?.costPence ?? 0;
    return {
      providerJobId: this.results.put(result),
      estimatedCostPence: costPence,
      estimatedReadyAt: new Date(this.now()),
    };
  }

  async poll(providerJobId: string): Promise<ProviderPollResult> {
    if (isSyncJobId(providerJobId)) return this.results.get(providerJobId);
    return this.pollAsync(providerJobId);
  }

  async cancel(providerJobId: string): Promise<void> {
    if (isSyncJobId(providerJobId)) this.results.delete(providerJobId);
  }

  /** Hive documents no free health endpoint; every task is billed. Report configuration only. */
  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    if (!this.options.apiKey) {
      const env = this.apiVersion === 'v3' ? 'HIVE_V3_SECRET_KEY' : 'HIVE_API_KEY';
      return { healthy: false, reason: `auth: ${env} not set` };
    }
    return {
      healthy: true,
      reason: `not probed: Hive has no unbilled health endpoint (API ${this.apiVersion})`,
    };
  }

  /** 20.6: V3 is synchronous only (hive-v3.ts); the result is parked like a V2 sync scan. */
  private async scanV3(request: ContentSafetyRequest): Promise<ProviderPollResult> {
    const frames = await scanWithV3(request, {
      secretKey: this.options.apiKey,
      fetchImpl: this.fetchImpl,
      maxFrames: this.maxFrames,
      frameJpeg: this.options.frameJpeg,
    });
    const scan = summariseFrames(frames);
    const costPence = usdToPence(scan.framesAnalysed * USD_PER_FRAME, this.options.usdToGbpRate);
    return { state: 'succeeded', output: { metadata: { ...scan, costPence } } };
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
    return this.fromTaskObject(body);
  }

  private async submitAsync(request: ContentSafetyRequest): Promise<ProviderSubmitResult> {
    if (!request.callbackUrl?.startsWith('https://')) {
      throw this.invalid(
        `Video is ${request.durationSec}s; Hive sync moderation accepts up to ${MAX_SYNC_DURATION_SEC}s and async needs an https callback URL`,
      );
    }
    const form = new FormData();
    form.append('url', request.mediaUrl);
    form.append('callback_url', request.callbackUrl);
    const { body } = await httpJson<HiveAsyncAck>(
      ASYNC_URL,
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
    const taskId = body.task_id ?? body.id ?? body.task_ids?.[0];
    if (!taskId || isSyncJobId(taskId)) {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'unknown', retryable: true },
        'Hive async acknowledgement had no task id',
      );
    }
    return {
      providerJobId: taskId,
      estimatedCostPence: this.estimateCostPence(request),
      estimatedReadyAt: new Date(this.now() + request.durationSec * 1000),
    };
  }

  private async pollAsync(taskId: string): Promise<ProviderPollResult> {
    if (!this.options.asyncResults) {
      return {
        state: 'failed',
        error: {
          class: 'unknown',
          message: 'No store for Hive async callbacks is configured',
          retryable: false,
        },
      };
    }
    const body = await this.options.asyncResults(taskId);
    if (body === null || body === undefined) return { state: 'running' };
    return this.fromTaskObject(body as HiveResponse);
  }

  private fromTaskObject(body: HiveResponse): ProviderPollResult {
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

/** 20.6: whether a render of this length goes to Hive's async API (V2 only; V3 has none). */
export function usesAsyncHiveScan(durationSec: number, apiVersion: HiveApiVersion = 'v2'): boolean {
  return apiVersion === 'v2' && durationSec > MAX_SYNC_DURATION_SEC;
}
