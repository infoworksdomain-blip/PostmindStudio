import type { TextOverlay } from '@prisma/client';
import { ConfigurationError } from '../../errors';
import { overlayStyleFromRow } from './params';
import { preRenderOverlay, type PreRenderDeps } from './prerender';
import {
  fontSources,
  needsPreRender,
  overlayClip,
  preRenderedClip,
  type FrameSize,
  type OverlayRow,
} from './shotstack';

// BACKLOG 8.3 — build the overlay track for a Shotstack edit from text_overlays rows: each
// overlay is placed at (shot start + overlay start); native animations become rich-text clips,
// the rest are pre-rendered (8.4). Returns the clips and the timeline.fonts entries they need.

export interface PlacedOverlay {
  row: TextOverlay;
  /** Seconds from the start of the video to the start of the shot (0 for whole-video). */
  offsetSec: number;
}

export function toOverlayRow(row: TextOverlay): OverlayRow | null {
  const style = overlayStyleFromRow.safeParse({ ...row, effect: row.effect ?? null });
  if (!style.success) return null;
  return {
    ...style.data,
    id: row.id,
    text: row.text,
    startAtSec: row.startAtSec,
    endAtSec: row.endAtSec,
  };
}

export interface OverlayTrack {
  clips: Record<string, unknown>[];
  fonts: Array<{ src: string }>;
  skipped: string[];
}

export async function buildOverlayTrack(
  placed: PlacedOverlay[],
  input: { frame: FrameSize; organisationId: string; preRender: PreRenderDeps },
): Promise<OverlayTrack> {
  const track: OverlayTrack = { clips: [], fonts: [], skipped: [] };
  if (placed.length === 0) return track;
  if (!input.preRender.fontsBaseUrl) {
    // Shotstack has no system fonts: rendering overlays without a font source would fail.
    throw new ConfigurationError('STUDIO_FONTS_BASE_URL is required to render text overlays');
  }
  const families = new Set<string>();
  const ordered = [...placed].sort(
    (a, b) =>
      a.offsetSec + a.row.startAtSec - (b.offsetSec + b.row.startAtSec) ||
      a.row.sortOrder - b.row.sortOrder,
  );
  for (const { row, offsetSec } of ordered) {
    const overlay = toOverlayRow(row);
    if (!overlay) {
      track.skipped.push(row.id);
      continue;
    }
    if (needsPreRender(overlay)) {
      const src = await preRenderOverlay(
        input.preRender,
        input.organisationId,
        overlay,
        input.frame,
      );
      track.clips.push(preRenderedClip(overlay, { src, offsetSec }));
    } else {
      families.add(overlay.fontFamily);
      track.clips.push(overlayClip(overlay, { frame: input.frame, offsetSec }));
    }
  }
  track.fonts = fontSources(families, input.preRender.fontsBaseUrl);
  return track;
}

/**
 * Shotstack forbids overlapping clips on one track, so overlapping overlays are spread over as
 * many tracks as needed (first-fit), top track first.
 */
export function packTracks(
  clips: Record<string, unknown>[],
): Array<{ clips: Record<string, unknown>[] }> {
  const tracks: Array<{ clips: Record<string, unknown>[]; end: number }> = [];
  for (const clip of clips) {
    const start = Number(clip.start);
    const end = start + Number(clip.length);
    const free = tracks.find((t) => t.end <= start + 1e-6);
    if (free) {
      free.clips.push(clip);
      free.end = end;
    } else {
      tracks.push({ clips: [clip], end });
    }
  }
  return tracks.map((t) => ({ clips: t.clips }));
}

/** Put overlay tracks above the edit's tracks (tracks[0] is the top layer) and add its fonts. */
export function mergeOverlayTrack(
  edit: Record<string, unknown>,
  track: OverlayTrack,
): Record<string, unknown> {
  if (track.clips.length === 0) return edit;
  const timeline = edit.timeline as { tracks: unknown[]; fonts?: unknown[] };
  return {
    ...edit,
    timeline: {
      ...timeline,
      fonts: [...(timeline.fonts ?? []), ...track.fonts],
      tracks: [...packTracks(track.clips), ...timeline.tracks],
    },
  };
}
