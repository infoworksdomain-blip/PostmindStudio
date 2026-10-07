import { CostCapPausedError, KillSwitchTriggeredError, RateDeferredError } from '../../errors';
import type { PipelineDeps } from './deps';
import { pickFallbackTrack } from './music-library';
import { libraryTrackAsset } from './music-library-asset';
import type { buildMusicPrompt } from './music-prompt';

// 25.x — music never silent under provider limits (production 2026-10-07: six slideshows started
// together; ElevenLabs Music refused one with "too_many_concurrent_requests … maximum of 2", the
// video rendered with no audio at all (−70 LUFS) and the quality gate failed it, while another
// video of the same batch had reused a music-library track).
//
// When generating the run's track fails for any reason the run may survive (provider rate limit,
// outage, timeout, no credits, open breaker, no provider routable…), the video takes a track from
// the music library instead (music-library.ts pickFallbackTrack: its own prompt key first, then
// any track long enough, then the longest one looped). It costs nothing: no provider call, the
// asset's costPence is 0, and music cost is only ever recorded for generated tracks. Only when
// the library holds no usable track (or is off: STUDIO_MUSIC_LIBRARY=off) does the video render
// without music, as before (warned).
//
// Not a fallback case (rethrown): a full Studio-side slot or rate window (RateDeferredError — the
// job waits for a slot, 20.29, and generates then), a paused budget or an engaged kill switch
// (they stop the whole run, spec 12.5).

/**
 * Fallback picks when tracks turn out to have lost their object (each is dropped, so the next
 * video does not meet it again). CI 2026-10-07: 3 was too few — several dead rows of the same
 * prompt key were picked before the live track of another key, and the video went silent.
 */
export const MAX_FALLBACK_PICKS = 12;

type BuiltPrompt = ReturnType<typeof buildMusicPrompt>;

/** What to do with an error from producing the run's music. */
export function musicFailureHandling(err: unknown): 'rethrow' | 'fallback' {
  if (
    err instanceof RateDeferredError ||
    err instanceof CostCapPausedError ||
    err instanceof KillSwitchTriggeredError
  ) {
    return 'rethrow';
  }
  return 'fallback';
}

export interface FallbackTrack {
  stored: { bucket: string; key: string; durationSec: number };
  assetId: string;
  libraryTrackId: string;
  match: 'prompt' | 'any' | 'loop';
}

/**
 * A library track as this project's music after a failed generation, or null when the library
 * has none usable. Never throws: a fallback problem leaves the video as it would have been.
 */
export async function fallbackLibraryTrack(
  deps: Pick<PipelineDeps, 'db' | 'storage' | 'logger' | 'now'>,
  input: {
    project: { id: string; organisationId: string };
    built?: BuiltPrompt;
    requestSec: number;
    reason: string;
  },
): Promise<FallbackTrack | null> {
  const tried: string[] = [];
  try {
    for (let i = 0; i < MAX_FALLBACK_PICKS; i += 1) {
      const track = await pickFallbackTrack(deps, {
        promptKey: input.built?.key,
        minSec: input.requestSec,
        excludeIds: tried,
      });
      if (!track) return null;
      tried.push(track.id);
      const asset = await libraryTrackAsset(deps, {
        project: input.project,
        track,
        // Only a same-key track long enough stands for this prompt on a later re-render.
        fingerprint: track.match === 'prompt' && input.built ? input.built.key : null,
        built: input.built,
        fallbackFrom: input.reason,
      });
      if (!asset) continue;
      return {
        stored: { bucket: track.s3Bucket, key: track.s3Key, durationSec: track.durationSec },
        assetId: asset.id,
        libraryTrackId: track.id,
        match: track.match,
      };
    }
    return null;
  } catch (err) {
    deps.logger.warn({ err, projectId: input.project.id }, 'music library fallback failed');
    return null;
  }
}
