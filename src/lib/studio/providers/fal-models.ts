import type {
  AspectRatio,
  ImageToVideoRequest,
  TextToVideoRequest,
  VideoResolution,
} from './interface';
import { FAL_VIDEO_USD_PER_SECOND } from './pricing';

// BACKLOG 24.1 — the fal.ai video models Studio can buy clips from (providers/fal.ts). Every
// endpoint id, input field and enum below is from fal's OpenAPI schema for that endpoint
// (https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>) and its model page
// (https://fal.ai/models/<id>), read 2026-10-06. Prices live in pricing.ts.
//
//   minimax-h3-max  minimax/h3-max/text-to-video, minimax/h3-max/image-to-video
//     prompt (1–50000), prompt_expansion_mode (required: disabled|balanced|quality), duration
//     (number 0.92–15, default 5), resolution 480P|768P|1080P (default 768P); t2v aspect_ratio
//     21:9|16:9|4:3|1:1|3:4|9:16; i2v image_url (first frame; no aspect_ratio, the frame sets it).
//     Output video only (no audio track).
//   ltx-2.3-fast    fal-ai/ltx-2.3/text-to-video/fast, fal-ai/ltx-2.3/image-to-video/fast
//     prompt (1–5000), duration 6|8|…|20 (integer; >10 s only at 25 fps and 1080p), resolution
//     1080p|1440p|2160p, fps 24|25|48|50 (default 25), generate_audio (default true); t2v
//     aspect_ratio 16:9|9:16; i2v image_url (required) and aspect_ratio auto|16:9|9:16.
//   veo-3.1-lite    fal-ai/veo3.1/lite, fal-ai/veo3.1/lite/image-to-video
//     prompt, duration "4s"|"6s"|"8s", resolution 720p|1080p, generate_audio (default true);
//     t2v aspect_ratio 16:9|9:16; i2v image_url (required) and aspect_ratio auto|16:9|9:16.
//
// Shots are rounded UP to the next length a model offers and the composer trims the clip to the
// shot (edl.ts `length`). Studio always asks for silent clips (the composer lays the narration and
// music; generate_audio does not change LTX's price, and Veo Lite is cheaper without audio).

export const FAL_VIDEO_MODEL_KEYS = ['minimax-h3-max', 'ltx-2.3-fast', 'veo-3.1-lite'] as const;
export type FalVideoModelKey = (typeof FAL_VIDEO_MODEL_KEYS)[number];

export type FalVideoRequest = TextToVideoRequest | ImageToVideoRequest;
export type FalMode = 't2v' | 'i2v';

/** What one model would be asked for a request: the fal input and the billed seconds. */
export interface FalVideoPlan {
  model: FalVideoModelKey;
  mode: FalMode;
  endpointId: string;
  input: Record<string, unknown>;
  billedSec: number;
  usdPerSec: number;
  resolution: string;
}

export interface FalVideoModel {
  key: FalVideoModelKey;
  label: string;
  endpoints: Record<FalMode, string>;
  /** Doc pages, for scripts and the plans note. */
  docs: readonly string[];
  /** undefined = this model cannot serve the request (length, ratio or prompt out of range). */
  plan(request: FalVideoRequest): FalVideoPlan | undefined;
}

/** The smallest offered length that covers the shot, or undefined when the shot is too long. */
function roundUp(durationSec: number, offered: readonly number[]): number | undefined {
  return offered.find((d) => d >= durationSec);
}

function modeOf(request: FalVideoRequest): FalMode {
  return request.capability === 'image_to_video' ? 'i2v' : 't2v';
}

function promptFits(prompt: string, max: number): boolean {
  const trimmed = prompt.trim();
  return trimmed.length >= 1 && trimmed.length <= max;
}

// 4:5 is offered by none of these models; the nearest portrait ratio is used and the composer's
// fit "cover" crops the difference (as for Luma). 1:1 is skipped where no square ratio exists.
const PORTRAIT_LANDSCAPE: Partial<Record<AspectRatio, string>> = {
  '9:16': '9:16',
  '16:9': '16:9',
  '4:5': '9:16',
};

const H3_RATIOS: Record<AspectRatio, string> = {
  '9:16': '9:16',
  '16:9': '16:9',
  '1:1': '1:1',
  '4:5': '3:4',
};

const H3_MIN_SEC = 0.92;
const H3_MAX_SEC = 15;
const H3_MAX_PROMPT = 50_000;
const LTX_DURATIONS = [6, 8, 10, 12, 14, 16, 18, 20] as const;
const LTX_MAX_PROMPT = 5000;
const VEO_LITE_DURATIONS = [4, 6, 8] as const;
// fal does not state a Veo 3.1 Lite prompt limit; Veo 3.1 Fast's schema caps prompts at 20000.
const VEO_LITE_MAX_PROMPT = 20_000;

function h3Resolution(resolution: VideoResolution | undefined): '480P' | '768P' | '1080P' {
  if (resolution === '480p') return '480P';
  if (resolution === '1080p') return '1080P';
  return '768P'; // 720p (every tier since 21.3) and the default: H3's nearest is 768P.
}

const minimaxH3Max: FalVideoModel = {
  key: 'minimax-h3-max',
  label: 'MiniMax H3 Max',
  endpoints: { t2v: 'minimax/h3-max/text-to-video', i2v: 'minimax/h3-max/image-to-video' },
  docs: [
    'https://fal.ai/models/minimax/h3-max/text-to-video/api',
    'https://fal.ai/models/minimax/h3-max/image-to-video/api',
  ],
  plan(request) {
    const { durationSec } = request;
    if (durationSec < H3_MIN_SEC || durationSec > H3_MAX_SEC) return undefined;
    if (!promptFits(request.prompt, H3_MAX_PROMPT)) return undefined;
    const mode = modeOf(request);
    const resolution = h3Resolution(request.resolution);
    const input: Record<string, unknown> = {
      prompt: request.prompt.trim(),
      prompt_expansion_mode: 'balanced', // required; fal's documented default
      duration: durationSec,
      resolution,
    };
    if (request.capability === 'image_to_video') input.image_url = request.imageUrl;
    else input.aspect_ratio = H3_RATIOS[request.aspectRatio];
    return {
      model: 'minimax-h3-max',
      mode,
      endpointId: this.endpoints[mode],
      input,
      billedSec: durationSec,
      usdPerSec: FAL_VIDEO_USD_PER_SECOND['minimax-h3-max'][resolution],
      resolution,
    };
  },
};

const ltx23Fast: FalVideoModel = {
  key: 'ltx-2.3-fast',
  label: 'LTX-2.3 Fast',
  endpoints: {
    t2v: 'fal-ai/ltx-2.3/text-to-video/fast',
    i2v: 'fal-ai/ltx-2.3/image-to-video/fast',
  },
  docs: [
    'https://fal.ai/models/fal-ai/ltx-2.3/text-to-video/fast/api',
    'https://fal.ai/models/fal-ai/ltx-2.3/image-to-video/fast/api',
  ],
  plan(request) {
    const duration = roundUp(request.durationSec, LTX_DURATIONS);
    if (duration === undefined || request.durationSec <= 0) return undefined;
    if (!promptFits(request.prompt, LTX_MAX_PROMPT)) return undefined;
    const mode = modeOf(request);
    const ratio =
      request.capability === 'image_to_video' ? 'auto' : PORTRAIT_LANDSCAPE[request.aspectRatio];
    if (!ratio) return undefined;
    const input: Record<string, unknown> = {
      prompt: request.prompt.trim(),
      duration,
      resolution: '1080p', // the smallest offered; required for clips over 10 s
      aspect_ratio: ratio,
      fps: 25, // required for clips over 10 s
      generate_audio: false,
    };
    if (request.capability === 'image_to_video') input.image_url = request.imageUrl;
    return {
      model: 'ltx-2.3-fast',
      mode,
      endpointId: this.endpoints[mode],
      input,
      billedSec: duration,
      usdPerSec: FAL_VIDEO_USD_PER_SECOND['ltx-2.3-fast']['1080p'],
      resolution: '1080p',
    };
  },
};

const veo31Lite: FalVideoModel = {
  key: 'veo-3.1-lite',
  label: 'Veo 3.1 Lite (fal)',
  endpoints: { t2v: 'fal-ai/veo3.1/lite', i2v: 'fal-ai/veo3.1/lite/image-to-video' },
  docs: [
    'https://fal.ai/models/fal-ai/veo3.1/lite/api',
    'https://fal.ai/models/fal-ai/veo3.1/lite/image-to-video/api',
  ],
  plan(request) {
    const duration = roundUp(request.durationSec, VEO_LITE_DURATIONS);
    if (duration === undefined || request.durationSec <= 0) return undefined;
    if (!promptFits(request.prompt, VEO_LITE_MAX_PROMPT)) return undefined;
    const mode = modeOf(request);
    const ratio =
      request.capability === 'image_to_video' ? 'auto' : PORTRAIT_LANDSCAPE[request.aspectRatio];
    if (!ratio) return undefined;
    const resolution = request.resolution === '1080p' ? '1080p' : '720p';
    const input: Record<string, unknown> = {
      prompt: request.prompt.trim(),
      duration: `${duration}s`,
      resolution,
      aspect_ratio: ratio,
      generate_audio: false,
    };
    if (request.capability === 'image_to_video') input.image_url = request.imageUrl;
    return {
      model: 'veo-3.1-lite',
      mode,
      endpointId: this.endpoints[mode],
      input,
      billedSec: duration,
      usdPerSec: FAL_VIDEO_USD_PER_SECOND['veo-3.1-lite'][resolution],
      resolution,
    };
  },
};

export const FAL_VIDEO_MODELS: Readonly<Record<FalVideoModelKey, FalVideoModel>> = {
  'minimax-h3-max': minimaxH3Max,
  'ltx-2.3-fast': ltx23Fast,
  'veo-3.1-lite': veo31Lite,
};

export function isFalVideoModelKey(value: string): value is FalVideoModelKey {
  return (FAL_VIDEO_MODEL_KEYS as readonly string[]).includes(value);
}

/** Every endpoint id Studio may call, so a stored job id can never name another path. */
export function falEndpointFor(model: FalVideoModelKey, mode: FalMode): string {
  return FAL_VIDEO_MODELS[model].endpoints[mode];
}
