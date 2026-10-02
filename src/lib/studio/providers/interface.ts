// Provider adapter contract (BACKLOG 2.1–2.2, spec Section 8.9). Every external provider
// implements ProviderAdapter so the router (spec 6.4) can call them uniformly.
//
// DEVIATION from 8.9: `output.url` is optional. Text and embedding providers (Layers 1–2,
// library/image search) produce data, not files; their result is carried in `metadata`.
// Media providers always set `url`.
//
// CONVENTION: when an adapter knows the actual cost at poll time (e.g. Anthropic token usage),
// it reports it as `metadata.costPence` (integer pence). Otherwise the submit-time estimate
// stands. See tracked.ts.

export type ProviderCapability =
  | 'text_generation' // Layers 1–2: ideation, script + storyboard
  | 'embedding' // library + image-library similarity search
  | 'text_to_image' // Layer 3: IMAGE_STILL shots
  | 'text_to_video' // Layer 3: AI_CLIP shots without a source frame
  | 'image_to_video' // Layer 3: AI_CLIP shots from a source frame
  | 'avatar_video' // Layer 3: AI_AVATAR shots
  | 'stock_footage' // Layer 3: STOCK_FOOTAGE shots
  | 'tts' // Layer 4
  | 'music' // Layer 5
  | 'sfx' // Layer 5 sound effects (BACKLOG 13.27)
  | 'composition' // Layers 6–7
  | 'transcription' // Layer 8 captions
  | 'content_safety' // Layer 8
  | 'media_analysis'; // 13.36 library: BPM/key, CLIP visual + CLAP audio embeddings (not built)

export type AspectRatio = '9:16' | '16:9' | '1:1' | '4:5';

/** Classification used for retries and circuit-breaker accounting. */
export type ProviderErrorClass =
  | 'rate_limited'
  | 'timeout'
  | 'provider_unavailable'
  | 'auth'
  | 'insufficient_credits'
  /** 20.11: an account-level usage or spend limit the provider enforces (not a rate limit). */
  | 'account_limit'
  | 'invalid_request'
  | 'content_policy'
  | 'output_truncated'
  | 'result_expired'
  | 'unknown';

/** Error classes caused by the request, not by the provider's health. */
export const CLIENT_SIDE_ERROR_CLASSES: ReadonlySet<ProviderErrorClass> = new Set([
  'invalid_request',
  'content_policy',
  'output_truncated',
]);

/**
 * 20.11: problems with Studio's ACCOUNT at the provider (bad or unauthorised key, no credits,
 * a usage or spend limit reached). Retrying the same provider cannot help, so the provider is
 * held out of routing for a cooldown (circuit breaker) and the job fails over to the next
 * provider for the capability at once. See providers/account-errors.ts.
 */
export const ACCOUNT_ERROR_CLASSES: ReadonlySet<ProviderErrorClass> = new Set([
  'auth',
  'insufficient_credits',
  'account_limit',
]);

interface ProviderRequestBase {
  organisationId: string;
  projectId?: string;
  shotId?: string;
}

export interface TextGenerationRequest extends ProviderRequestBase {
  capability: 'text_generation';
  system: string;
  prompt: string;
  maxTokens?: number;
  /** JSON Schema; when set the provider must return JSON matching it. */
  outputSchema?: Record<string, unknown>;
  /** Images sent with the prompt (e.g. library keyframes), base64-encoded. */
  images?: Array<{ mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; data: string }>;
}

export interface EmbeddingRequest extends ProviderRequestBase {
  capability: 'embedding';
  input: string[];
  /** Addendum A7.4 / A7.7 store vector(1536). */
  dimensions: number;
}

export interface TextToImageRequest extends ProviderRequestBase {
  capability: 'text_to_image';
  prompt: string;
  aspectRatio: AspectRatio;
}

export interface TextToVideoRequest extends ProviderRequestBase {
  capability: 'text_to_video';
  prompt: string;
  durationSec: number;
  aspectRatio: AspectRatio;
}

export interface ImageToVideoRequest extends ProviderRequestBase {
  capability: 'image_to_video';
  prompt: string;
  imageUrl: string;
  durationSec: number;
  aspectRatio: AspectRatio;
}

export interface AvatarVideoRequest extends ProviderRequestBase {
  capability: 'avatar_video';
  /**
   * Publicly fetchable (e.g. presigned) URL of the shot's narration. The avatar lip-syncs to
   * this audio, so the presenter speaks in the brand voice produced by Layer 4.
   */
  audioUrl: string;
  /** Provider avatar id; when absent the adapter uses its configured stock avatar. */
  avatarId?: string;
  /** Expected output length (the narration's length), used for cost estimation. */
  durationSec: number;
  aspectRatio: AspectRatio;
}

export interface StockFootageRequest extends ProviderRequestBase {
  capability: 'stock_footage';
  /** The shot's scene description; adapters reduce it to search keywords. */
  query: string;
  /** Shortest clip wanted (the shot's length), in seconds. */
  durationSec: number;
  aspectRatio: AspectRatio;
}

export interface TtsRequest extends ProviderRequestBase {
  capability: 'tts';
  text: string;
  voiceId: string;
  languageCode?: string;
  /**
   * 15.B3: speaking rate, 1 = normal (ElevenLabs voice_settings.speed; documented range
   * 0.7–1.2). Used to fit narration to its shot; adapters without a rate control ignore it.
   */
  speed?: number;
}

export interface MusicRequest extends ProviderRequestBase {
  capability: 'music';
  /** Plain-language style prompt built by pipeline/music-prompt.ts (no lyrics, no artists). */
  prompt: string;
  /** Requested track length; adapters clamp or reject outside their documented range. */
  durationSec: number;
}

export interface CompositionRequest extends ProviderRequestBase {
  capability: 'composition';
  /** Provider-native edit decision list (e.g. a Shotstack Edit), built by Layer 6. */
  edit: Record<string, unknown>;
  /** Expected output length, used for cost estimation. */
  outputDurationSec: number;
}

export interface TranscriptionRequest extends ProviderRequestBase {
  capability: 'transcription';
  /** Publicly fetchable (e.g. presigned) URL of the audio or video file. */
  mediaUrl: string;
  /** For cost estimation. */
  durationSec: number;
  /** 15.C5: BCP 47 tag of the spoken language (Studio language list); omitted = auto. */
  languageCode?: string;
}

export interface ContentSafetyRequest extends ProviderRequestBase {
  capability: 'content_safety';
  /** Publicly fetchable (e.g. presigned) URL of the rendered video. */
  mediaUrl: string;
  durationSec: number;
  /**
   * BACKLOG 13.25: where the provider posts the result of an asynchronous scan. Required for
   * media longer than the provider's synchronous limit (Hive: 90 s); ignored otherwise.
   */
  callbackUrl?: string;
}

export interface SfxRequest extends ProviderRequestBase {
  capability: 'sfx';
  /** The Layer 2 cue ("whoosh", "cash register ding"): search keywords, not instructions. */
  query: string;
  /** Longest clip wanted, in seconds. */
  maxDurationSec: number;
}

/** 13.36: what the (not yet chosen) inference host would compute for one library video. */
export type MediaAnalysis = 'bpm_key' | 'clip_visual' | 'clap_audio';

export interface MediaAnalysisRequest extends ProviderRequestBase {
  capability: 'media_analysis';
  /** Publicly fetchable (e.g. presigned) URL of the video or audio file. */
  mediaUrl: string;
  analyses: MediaAnalysis[];
  durationSec: number;
}

export type ProviderRequest =
  | TextGenerationRequest
  | EmbeddingRequest
  | TextToImageRequest
  | TextToVideoRequest
  | ImageToVideoRequest
  | AvatarVideoRequest
  | StockFootageRequest
  | TtsRequest
  | MusicRequest
  | CompositionRequest
  | TranscriptionRequest
  | ContentSafetyRequest
  | SfxRequest
  | MediaAnalysisRequest;

export interface ProviderSubmitResult {
  providerJobId: string;
  estimatedCostPence: number;
  estimatedReadyAt: Date;
}

export interface ProviderPollResult {
  state: 'running' | 'succeeded' | 'failed';
  output?: { url?: string; metadata: unknown };
  error?: { class: ProviderErrorClass; message: string; retryable: boolean };
}

export interface ProviderAdapter {
  readonly providerId: string;
  readonly capabilities: readonly ProviderCapability[];
  submit(request: ProviderRequest): Promise<ProviderSubmitResult>;
  poll(providerJobId: string): Promise<ProviderPollResult>;
  cancel(providerJobId: string): Promise<void>;
  healthCheck(): Promise<{ healthy: boolean; reason?: string }>;
  /**
   * 20.20: download the provider's own output URL when it needs the provider's credentials
   * (Veo: the x-goog-api-key header). Layer 3 uses it instead of a plain fetch when present.
   */
  fetchOutput?(url: string): Promise<Response>;
}
