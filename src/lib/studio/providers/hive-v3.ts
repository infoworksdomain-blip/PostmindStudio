import { ProviderError } from '../../errors';
import { httpJson } from './http';
import type { ContentSafetyRequest } from './interface';
import { providerError, type ErrorClassification } from './provider-errors';
import type { ScannedFrame } from './hive-scan';

// BACKLOG 20.6 — Hive Visual Moderation over the self-serve V3 API. Contract from Hive's docs
// (read 2026-09-30):
//
// https://docs.thehive.ai/docs/visual-moderation-playground (the "API Docs" link of the
// playground https://thehive.ai/models/hive/visual-moderation):
//   POST https://api.thehive.ai/api/v3/hive/visual-moderation
//   header `authorization: Bearer <SECRET_KEY>`
//   JSON body {"input":[{"media_url":"<public url>"}]} (or "media_base64"), OR multipart/form-data
//   with the file in field `media`. "Currently, the API only supports 1 object to moderate at a
//   time." Images .jpg .png .webp .gif; video .mp4 .webm .m4v. Size: URL/multipart 200MB,
//   base64 20MB. Video length limit (URL/Base64): 60 seconds. The response is synchronous:
//   {"task_id","model","version","output":[{"extra":[],"classes":[{"class_name","value"}]}]};
//   for video, one output entry per sampled frame with extra [{name:"frame_index"},
//   {name:"timestamp", value:<seconds>}]. Playground/V3 default limit 100 requests/day.
// https://docs.thehive.ai/docs/visual-content-moderation: V3 "for developer testing ONLY: 100
//   requests/day limit"; "V3 returns the same class names and confidence scores as V2";
//   Visual Moderation "requires an annual contract" for production volume (V2 Enterprise).
// https://docs.thehive.ai/docs/frequently-asked-questions-faq: V3 is the self-serve "instant-on"
//   API with default rate limits; V2 needs a project enabled by Hive Sales.
// https://docs.thehive.ai/docs/image-generation-models and /docs/hive-vision-language-model-vlm:
//   the V3 key is created under "API Keys" and requests use its **Secret Key** as the Bearer
//   token; the "Access Key ID" shown next to it is a unique identifier, not a credential.
// https://docs.thehive.ai/reference/error-codes and /reference/common-errors: HTTP 429 = rate
//   limited (`{ return_code: 429, message: 'Project has been rate limited' }`), 403 = API key
//   problem, 405 = insufficient balance; bodies are {return_code, message}.
// Pricing: thehive.ai/models/hive/visual-moderation "$3.00 / 1000 images".
//
// NOT documented for V3 (so not used): an async endpoint or callbacks, a task-status endpoint,
// a cancel endpoint. Every V3 call is synchronous.
//
// Renders up to 60 s are sent as ONE request (media_url = the presigned render URL); Hive samples
// the video itself (1 frame/s by default, docs.thehive.ai/docs/visual-moderation-api), so every
// second is checked, exactly as with V2. Longer renders (long-form) exceed V3's 60 s limit: we
// sample HIVE_V3_MAX_FRAMES evenly spaced frames with ffmpeg (pipeline/media-probe.ts frameJpeg)
// and send each as an image (multipart `media`). TRADE-OFF: each frame is one request, so a long
// render costs N of the ~100 requests/day, and content between samples is NOT checked (a 6-minute
// video with N=10 is checked every 36 s). The per-frame scores are aggregated with the same
// class maxima as V2, so the pass/review/block policy is unchanged. For production volume and
// full-coverage long-form checks, use a V2 Enterprise key (HIVE_API_VERSION=v2).

export const PROVIDER_ID = 'hive';
export const V3_URL = 'https://api.thehive.ai/api/v3/hive/visual-moderation';
/** docs: "Video Length Limits: URL/Base64: 60 seconds". */
export const MAX_V3_VIDEO_SEC = 60;
/** Frame grabs for long renders are scaled to at most this width (a few hundred KB of JPEG). */
export const V3_FRAME_MAX_WIDTH = 1024;
const TIMEOUT_MS = 120_000;

interface HiveV3Output {
  extra?: Array<{ name?: string; value?: unknown }>;
  classes?: Array<{ class_name?: string; value?: number }>;
}

export interface HiveV3Response {
  task_id?: string;
  model?: string;
  version?: string;
  output?: HiveV3Output[];
}

export type FrameGrabber = (url: string, atSec: number, maxWidth: number) => Promise<Uint8Array>;

export interface HiveV3ClientOptions {
  secretKey: string;
  fetchImpl: typeof fetch;
  /** Frames sampled from renders longer than 60 s. */
  maxFrames: number;
  /** ffmpeg frame grab; without it renders over 60 s cannot be scanned (fail closed). */
  frameJpeg?: FrameGrabber;
}

function extraNumber(output: HiveV3Output, name: string): number | undefined {
  const value = output.extra?.find((e) => e.name === name)?.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * V3 output entries → scanned frames. A video's entries carry their own `timestamp`; an image
 * (a sampled frame) is placed at `atSec`.
 */
export function framesFromV3(body: HiveV3Response, atSec?: number): ScannedFrame[] {
  return (body.output ?? []).map((output, index) => ({
    time: atSec ?? extraNumber(output, 'timestamp') ?? extraNumber(output, 'frame_index') ?? index,
    classes: (output.classes ?? []).flatMap((c) =>
      typeof c.class_name === 'string' && typeof c.value === 'number'
        ? [{ class: c.class_name, score: c.value }]
        : [],
    ),
  }));
}

/** Evenly spaced sample times (mid-points of N equal slices), N = min(maxFrames, ⌈duration⌉). */
export function sampleTimes(durationSec: number, maxFrames: number): number[] {
  const count = Math.max(1, Math.min(maxFrames, Math.ceil(durationSec)));
  return Array.from({ length: count }, (_, i) =>
    Number(((durationSec * (i + 0.5)) / count).toFixed(3)),
  );
}

/** V3 requests one render costs: 1 up to 60 s, else one per sampled frame. */
export function v3RequestCount(durationSec: number, maxFrames: number): number {
  return durationSec <= MAX_V3_VIDEO_SEC ? 1 : sampleTimes(durationSec, maxFrames).length;
}

/** Frames Hive analyses (and bills): 1/s up to 60 s, else the sampled frames. */
export function v3FrameCount(durationSec: number, maxFrames: number): number {
  return durationSec <= MAX_V3_VIDEO_SEC
    ? Math.max(1, Math.ceil(durationSec))
    : sampleTimes(durationSec, maxFrames).length;
}

function bodyMessage(body: unknown): string | undefined {
  if (typeof body === 'object' && body && 'message' in body) {
    return String((body as { message: unknown }).message);
  }
  return typeof body === 'string' && body.trim() ? body.slice(0, 300) : undefined;
}

/** 405 = "You have insufficient balance in your Hive account" (reference/error-codes). */
function classifyV3Error(status: number): ErrorClassification | undefined {
  return status === 405 ? { errorClass: 'insufficient_credits', retryable: false } : undefined;
}

/** Operator-facing wording for the V3 failures that need action. */
function explain(err: ProviderError): ProviderError {
  const hint: Record<string, string> = {
    rate_limited:
      'Hive V3 rate limit reached (self-serve V3 keys allow about 100 requests a day); the check fails closed and is retried, nothing is published unchecked',
    auth: 'Hive rejected HIVE_V3_SECRET_KEY: use the "Secret Key" column of Hive\'s API Keys (V3) dialog, not the Access Key ID',
    insufficient_credits: 'Hive account has insufficient balance for V3 requests',
  };
  const prefix = hint[err.errorClass];
  if (!prefix) return err;
  return new ProviderError(
    PROVIDER_ID,
    err.errorClass,
    `${prefix} (${err.message})`,
    err.retryable,
    { apiVersion: 'v3' },
  );
}

async function post(body: BodyInit, headers: Record<string, string>, options: HiveV3ClientOptions) {
  try {
    const { body: result } = await httpJson<HiveV3Response>(
      V3_URL,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${options.secretKey}`, ...headers },
        body,
      },
      {
        providerId: PROVIDER_ID,
        fetchImpl: options.fetchImpl,
        timeoutMs: TIMEOUT_MS,
        errorMessage: bodyMessage,
        classifyError: classifyV3Error,
      },
    );
    return result;
  } catch (err) {
    throw err instanceof ProviderError ? explain(err) : err;
  }
}

function requireFrames(frames: ScannedFrame[]): ScannedFrame[] {
  if (frames.length === 0) {
    throw providerError(
      PROVIDER_ID,
      { errorClass: 'unknown', retryable: true },
      'Hive V3 returned no frames',
    );
  }
  return frames;
}

/** One request with the render URL (≤ 60 s). */
async function scanVideoUrl(
  request: ContentSafetyRequest,
  options: HiveV3ClientOptions,
): Promise<ScannedFrame[]> {
  const body = await post(
    JSON.stringify({ input: [{ media_url: request.mediaUrl }] }),
    { 'content-type': 'application/json' },
    options,
  );
  return requireFrames(framesFromV3(body));
}

/** One multipart request per sampled frame (> 60 s). Any failure fails the whole scan. */
async function scanSampledFrames(
  request: ContentSafetyRequest,
  options: HiveV3ClientOptions,
): Promise<ScannedFrame[]> {
  const grab = options.frameJpeg;
  if (!grab) {
    throw providerError(
      PROVIDER_ID,
      { errorClass: 'invalid_request', retryable: false },
      `Video is ${Math.round(request.durationSec)}s; Hive V3 accepts up to ${MAX_V3_VIDEO_SEC}s and frame sampling is not configured`,
    );
  }
  const frames: ScannedFrame[] = [];
  for (const at of sampleTimes(request.durationSec, options.maxFrames)) {
    let jpeg: Uint8Array;
    try {
      jpeg = await grab(request.mediaUrl, at, V3_FRAME_MAX_WIDTH);
    } catch (err) {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'invalid_request', retryable: false },
        `Could not sample a frame at ${at}s for the Hive V3 scan: ${(err as Error).message}`.slice(
          0,
          500,
        ),
      );
    }
    const form = new FormData();
    form.append(
      'media',
      new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }),
      `frame-${at}.jpg`,
    );
    const body = await post(form, {}, options);
    frames.push(...requireFrames(framesFromV3(body, at)));
  }
  return frames;
}

/** Scan a render with V3: the frames and their class scores. */
export function scanWithV3(
  request: ContentSafetyRequest,
  options: HiveV3ClientOptions,
): Promise<ScannedFrame[]> {
  return request.durationSec <= MAX_V3_VIDEO_SEC
    ? scanVideoUrl(request, options)
    : scanSampledFrames(request, options);
}
