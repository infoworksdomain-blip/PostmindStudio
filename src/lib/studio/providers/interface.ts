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
  | 'composition' // Layers 6–7
  | 'transcription' // Layer 8 captions
  | 'content_safety'; // Layer 8

export type AspectRatio = '9:16' | '16:9' | '1:1' | '4:5';

/** Classification used for retries and circuit-breaker accounting. */
export type ProviderErrorClass =
  | 'rate_limited'
  | 'timeout'
  | 'provider_unavailable'
  | 'auth'
  | 'insufficient_credits'
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

export interface TtsRequest extends ProviderRequestBase {
  capability: 'tts';
  text: string;
  voiceId: string;
  languageCode?: string;
}

export interface CompositionRequest extends ProviderRequestBase {
  capability: 'composition';
  /** Provider-native edit decision list (e.g. a Shotstack Edit), built by Layer 6. */
  edit: Record<string, unknown>;
  /** Expected output length, used for cost estimation. */
  outputDurationSec: number;
}

export type ProviderRequest =
  | TextGenerationRequest
  | EmbeddingRequest
  | TextToImageRequest
  | TextToVideoRequest
  | ImageToVideoRequest
  | TtsRequest
  | CompositionRequest;

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
}
