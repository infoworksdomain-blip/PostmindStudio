import { roundSec } from './edl-time';

// BACKLOG 15.B4 — per-shot music duck automation (spec 5.7 "music duck automation"; PROGRESS
// [OPS-music] recorded a constant bed level). The music track is split into clips whose volume
// follows the narration: ducked under shots that have a voice clip, raised where there is none
// (intro/outro cards, silent shots). Only documented Shotstack AudioAsset fields are used
// (https://shotstack.io/docs/api/#tocs_audioasset, read 2026-09-28): `volume` 0–1, `trim` ("The
// start trim point of the audio clip, in seconds … Audio will start from the in trim point") and
// `effect` fadeOut. A shorter track loops: each clip trims to its position inside the loop.

export interface MusicSpan {
  startSec: number;
  endSec: number;
  volume: number;
}

/** Merge adjacent spans at the same level; drop empty ones. */
export function mergeSpans(spans: MusicSpan[]): MusicSpan[] {
  const out: MusicSpan[] = [];
  for (const span of spans) {
    if (span.endSec - span.startSec < 0.001) continue;
    const last = out.at(-1);
    if (last && last.volume === span.volume && Math.abs(last.endSec - span.startSec) < 0.001) {
      out[out.length - 1] = { ...last, endSec: span.endSec };
    } else {
      out.push({ ...span });
    }
  }
  return out;
}

/**
 * Music clips for the given level spans. `trackSec` is the music file's length (the track is
 * repeated when shorter than the video); the final clip fades out.
 */
export function duckedMusicClips(input: {
  src: string;
  trackSec?: number;
  spans: MusicSpan[];
}): Record<string, unknown>[] {
  const spans = mergeSpans(input.spans);
  const videoSec = spans.at(-1)?.endSec ?? 0;
  const loop = input.trackSec && input.trackSec > 0 ? input.trackSec : videoSec;
  const clips: Record<string, unknown>[] = [];
  for (const span of spans) {
    let at = span.startSec;
    while (at < span.endSec - 0.001) {
      const inTrack = loop > 0 ? roundSec(at % loop) : 0;
      // A position a hair before the loop end counts as the start of the next repetition.
      const position = loop - inTrack < 0.001 ? 0 : inTrack;
      const length = Math.min(span.endSec - at, loop - position);
      clips.push({
        asset: {
          type: 'audio',
          src: input.src,
          volume: span.volume,
          ...(position > 0 && { trim: position }),
        },
        start: roundSec(at),
        length: roundSec(length),
      });
      at += length;
    }
  }
  const last = clips.at(-1);
  if (last) {
    const asset = last.asset as Record<string, unknown>;
    clips[clips.length - 1] = { ...last, asset: { ...asset, effect: 'fadeOut' } };
  }
  return clips;
}
