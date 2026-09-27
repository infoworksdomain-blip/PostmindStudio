import { NotImplementedError } from '../../errors';
import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderPollResult,
  ProviderRequest,
  ProviderSubmitResult,
} from './interface';

// BACKLOG 13.36 — BPM / musical key detection and CLIP (visual) / CLAP (audio) embeddings for the
// video library (Addendum A7). None of Studio's providers offers these: BPM and key need an audio
// analysis library (librosa or Essentia, Python) and CLIP / CLAP need a model host. Which host
// (a GPU/CPU inference service, a managed endpoint, or a Python worker next to Studio) is an
// OPERATOR DECISION, so this adapter is the final contract with no transport:
//   - healthCheck() → unhealthy "no inference host configured";
//   - submit() / poll() / cancel() → NotImplementedError;
//   - it is NOT registered in default-registry.ts and the router's media_analysis candidate
//     list is empty, so it is never selected.
//
// Where results will go (no migration until the host exists — expand-only when it does):
//   - bpm and key: video_library_analysis.musicEnvelope.bpm / .key (already in the JSON shape,
//     null today) — no new column;
//   - CLIP: video_library_embeddings."visualEmbedding" vector(512) NULL + "visualEmbeddingModel"
//     TEXT NULL (512 = ViT-B/32 image embedding size; set from the chosen model);
//   - CLAP: video_library_embeddings."audioEmbedding" vector(512) NULL + "audioEmbeddingModel"
//     TEXT NULL; both with HNSW cosine indexes like the existing text embedding;
//   - a re-analysis job for already ingested items (library queue).
// Poll output contract when built: metadata = { bpm: number | null, key: string | null,
// clipVisual: number[] | null, clapAudio: number[] | null, model: { clip?, clap?, bpm? } }.

export const MEDIA_ANALYSIS_PROVIDER_ID = 'media-analysis';
export const NO_INFERENCE_HOST = 'no inference host configured';
const PENDING = `Media analysis (BPM/key, CLIP, CLAP) is not built: ${NO_INFERENCE_HOST}`;

export class MediaAnalysisAdapter implements ProviderAdapter {
  readonly providerId = MEDIA_ANALYSIS_PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[] = ['media_analysis'];

  async submit(_request: ProviderRequest): Promise<ProviderSubmitResult> {
    throw new NotImplementedError(PENDING);
  }

  async poll(_providerJobId: string): Promise<ProviderPollResult> {
    throw new NotImplementedError(PENDING);
  }

  async cancel(_providerJobId: string): Promise<void> {
    throw new NotImplementedError(PENDING);
  }

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    return { healthy: false, reason: NO_INFERENCE_HOST };
  }
}
