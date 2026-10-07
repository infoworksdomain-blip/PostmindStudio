import type { PipelineDeps } from './deps';
import { dropLibraryTrack, type LibraryTrack } from './music-library';
import type { buildMusicPrompt } from './music-prompt';

// 23.1 / 25.x — a music library track laid under one project's edit: the project gets its own
// AUDIO_MUSIC asset pointing at the library object (no copy, no provider call, cost 0). Shared by
// the library rotation (music.ts reuseLibraryTrack) and the generation fallback (music-fallback.ts).

type BuiltPrompt = ReturnType<typeof buildMusicPrompt>;

export interface LibraryAssetInput {
  project: { id: string; organisationId: string };
  track: LibraryTrack;
  /**
   * The prompt key the asset is filed under (music.ts reuses a project's asset by it on a
   * re-render), or null when the track was picked for another key (25.x relaxed fallback): a
   * later run then tries to generate the right music again.
   */
  fingerprint: string | null;
  built?: BuiltPrompt;
  /** 25.x: why generation failed, when this track stands in for a generated one. */
  fallbackFrom?: string;
}

/**
 * The project's asset for a library track, or null when the track's object is gone (the row is
 * dropped so no other video picks it).
 */
export async function libraryTrackAsset(
  deps: Pick<PipelineDeps, 'db' | 'storage' | 'logger'>,
  input: LibraryAssetInput,
): Promise<{ id: string } | null> {
  const { project, track, built } = input;
  try {
    await deps.storage.size(track.s3Bucket, track.s3Key);
  } catch (err) {
    deps.logger.warn({ err, trackId: track.id }, 'music library track missing; dropped');
    await dropLibraryTrack(deps.db, track.id);
    return null;
  }
  return deps.db.videoAsset.create({
    data: {
      organisationId: project.organisationId,
      projectId: project.id,
      shotId: null,
      kind: 'AUDIO_MUSIC',
      source: `music-library:${track.id}`,
      s3Bucket: track.s3Bucket,
      s3Key: track.s3Key,
      durationSec: track.durationSec,
      fingerprint: input.fingerprint,
      providerJobId: null,
      costPence: 0,
      metadata: {
        ...(built && { prompt: built.prompt, descriptors: built.descriptors }),
        libraryTrackId: track.id,
        generatedBy: track.source,
        ...(input.fallbackFrom && { fallbackFrom: input.fallbackFrom }),
      },
    },
    select: { id: true },
  });
}
