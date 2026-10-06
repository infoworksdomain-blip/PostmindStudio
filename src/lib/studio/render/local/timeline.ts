import type { AspectRatio } from '../../providers/interface';
import { outputDimensions } from '../../pipeline/render-presets';
import {
  asNumber,
  asRecord,
  asString,
  parseColour,
  unsupported,
  type Json,
  type Rgba,
} from './edit-json';
import { boxPosition, htmlCard, richTextCard, type BoxPosition, type TextCard } from './text-card';

// BACKLOG 23.5 — the Shotstack edit the composer builds (the SAME edit Shotstack would get), read
// into a timeline the local ffmpeg renderer draws. Only the documented Shotstack fields Studio's
// builders write are understood (Edit API reference, https://shotstack.io/docs/api/, read
// 2026-10-06): timeline.background / tracks[].clips[] with asset (image, video, html, rich-text,
// audio), start, length, fit, effect, transition, position, offset, opacity, scale, transform,
// width, height; output format / resolution / aspectRatio / fps / quality / scaleTo. Tracks are
// listed top layer first. Anything else (a shape asset, a tween the renderer cannot follow, a
// video's own audio, overlapping audio) throws NotImplementedError and the variant goes to
// Shotstack as before.
//
// Timing Shotstack does not document is fixed here and recorded as a parity note:
//   - transition lengths: Studio's own overlay mapping (overlays/shotstack.ts) treats ≤ 300 ms
//     as "Fast" and ≥ 800 ms as "Slow", so plain = 0.5 s, Fast = 0.3 s, Slow = 0.8 s;
//   - Ken Burns: zoomIn/zoomOut scale 1 → 1.15 (Fast 1.25, Slow 1.08); slides pan across the
//     margin of a 1.15 zoom;
//   - audio fadeIn/fadeOut: 1 s (at most half the clip).

export const TRANSITION_SEC = { plain: 0.5, Fast: 0.3, Slow: 0.8 } as const;
export const KEN_BURNS_ZOOM = { plain: 0.15, Fast: 0.25, Slow: 0.08 } as const;
export const AUDIO_FADE_SEC = 1;
/** Longest edit drawn locally (the cheap formats are 6–60 s). */
export const MAX_LOCAL_SEC = 180;
/** libx264 constant rate factor per Shotstack output quality (lower = better). */
export const CRF_BY_QUALITY: Readonly<Record<string, number>> = { high: 20, medium: 23 };
const ALLOWED_FPS = new Set([24, 25, 30, 48, 50, 60]);

export interface FrameSpec {
  /** Layout size (pixel sizes in the edit follow it). */
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /** Encoded size (scaleTo hd drafts are laid out at 1080 and scaled down). */
  readonly outWidth: number;
  readonly outHeight: number;
  readonly crf: number;
}

export type Fit = 'crop' | 'contain' | 'cover' | 'none';

export interface SideCrop {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export type KenBurnsMove =
  'zoomIn' | 'zoomOut' | 'slideLeft' | 'slideRight' | 'slideUp' | 'slideDown';

export interface KenBurns {
  readonly move: KenBurnsMove;
  /** Extra zoom over the cover fill (0.15 = 115 %). */
  readonly amount: number;
}

export type ClipSource =
  | {
      readonly kind: 'image';
      readonly src: string;
      readonly fit: Fit;
      readonly kenBurns: KenBurns | null;
    }
  | {
      readonly kind: 'video';
      readonly src: string;
      readonly fit: Fit;
      readonly trimSec: number;
      readonly crop: SideCrop | null;
    }
  | { readonly kind: 'text'; readonly card: TextCard };

/** Clip placement: Shotstack `position` + `offset` (fractions of the frame; y positive up). */
export interface Placement {
  readonly position: BoxPosition;
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface BaseTransition {
  /** ffmpeg xfade transition name (ffmpeg-filters "xfade"). */
  readonly xfade: string;
  readonly durationSec: number;
}

export interface BaseClip extends Placement {
  readonly source: ClipSource;
  readonly startSec: number;
  readonly endSec: number;
  readonly transitionIn: BaseTransition | null;
  readonly transitionOut: BaseTransition | null;
}

export interface LayerMotion {
  /** Moves in from (dx, dy) px over durationSec (a slide transition). */
  readonly slideIn: {
    readonly dx: number;
    readonly dy: number;
    readonly durationSec: number;
  } | null;
  readonly slideOut: {
    readonly dx: number;
    readonly dy: number;
    readonly durationSec: number;
  } | null;
  /** A vertical bob (overlay "wave"): amplitude in px, period in seconds. */
  readonly wave: { readonly amplitudePx: number; readonly periodSec: number } | null;
}

export interface LayerClip extends Placement {
  readonly source: ClipSource;
  readonly startSec: number;
  readonly endSec: number;
  /** Clip `scale` (logos, watermarks); null = 1. */
  readonly scale: number | null;
  readonly opacity: number;
  readonly fadeInSec: number;
  readonly fadeOutSec: number;
  readonly motion: LayerMotion;
  readonly rotationDeg: number;
}

export interface AudioClip {
  readonly src: string;
  readonly startSec: number;
  readonly lengthSec: number;
  readonly trimSec: number;
  readonly volume: number;
  readonly fadeInSec: number;
  readonly fadeOutSec: number;
}

export interface LocalTimeline {
  readonly frame: FrameSpec;
  readonly backdrop: Rgba;
  /** The bottom visual track, in time order. */
  readonly base: readonly BaseClip[];
  /** Every other visual clip, bottom layer first. */
  readonly layers: readonly LayerClip[];
  readonly audio: readonly AudioClip[];
  readonly totalSec: number;
  /** What is drawn approximately (logged and recorded with the render). */
  readonly notes: readonly string[];
}

const CLIP_KEYS = new Set([
  'asset',
  'start',
  'length',
  'fit',
  'effect',
  'transition',
  'position',
  'offset',
  'opacity',
  'scale',
  'transform',
  'width',
  'height',
]);

const XFADE: Readonly<Record<string, string>> = {
  fade: 'fade',
  wipeLeft: 'wipeleft',
  wipeRight: 'wiperight',
  slideLeft: 'slideleft',
  slideRight: 'slideright',
  slideUp: 'slideup',
  slideDown: 'slidedown',
  zoom: 'zoomin',
};

/** "fadeFast" → { name: fade, speed: Fast }. */
export function splitSpeed(value: string): { name: string; speed: 'plain' | 'Fast' | 'Slow' } {
  const m = /^(.*?)(Fast|Slow)$/.exec(value);
  return m?.[1] ? { name: m[1], speed: m[2] as 'Fast' | 'Slow' } : { name: value, speed: 'plain' };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function baseTransition(value: unknown, notes: string[]): BaseTransition | null {
  if (value === undefined) return null;
  const name = asString(value) ?? unsupported('transition');
  const { name: kind, speed } = splitSpeed(name);
  const xfade = XFADE[kind];
  if (!xfade) notes.push(`transition ${name} drawn as a crossfade`);
  return { xfade: xfade ?? 'fade', durationSec: TRANSITION_SEC[speed] };
}

function kenBurnsOf(value: unknown): KenBurns | null {
  if (value === undefined) return null;
  const { name, speed } = splitSpeed(asString(value) ?? unsupported('effect'));
  const moves: readonly string[] = [
    'zoomIn',
    'zoomOut',
    'slideLeft',
    'slideRight',
    'slideUp',
    'slideDown',
  ];
  if (!moves.includes(name)) return unsupported(`effect ${String(value)}`);
  return { move: name as KenBurnsMove, amount: KEN_BURNS_ZOOM[speed] };
}

function fitOf(value: unknown): Fit {
  if (value === undefined) return 'crop'; // Shotstack's default
  if (value === 'crop' || value === 'contain' || value === 'cover' || value === 'none')
    return value;
  return unsupported(`fit ${String(value)}`);
}

function sideCrop(value: unknown): SideCrop | null {
  const c = asRecord(value);
  if (!c) return null;
  const side = (k: string) => Math.min(0.49, Math.max(0, asNumber(c[k]) ?? 0));
  const crop = {
    top: side('top'),
    bottom: side('bottom'),
    left: side('left'),
    right: side('right'),
  };
  return crop.top + crop.bottom + crop.left + crop.right > 0 ? crop : null;
}

function sourceOf(clip: Json, notes: string[]): ClipSource {
  const asset = asRecord(clip.asset) ?? unsupported('clip without an asset');
  switch (asset.type) {
    case 'image':
      return {
        kind: 'image',
        src: asString(asset.src) ?? unsupported('image without src'),
        fit: fitOf(clip.fit),
        kenBurns: kenBurnsOf(clip.effect),
      };
    case 'video': {
      if (clip.effect !== undefined) unsupported('effect on a video clip');
      // Shotstack VideoAsset volume defaults to 1: a clip without volume 0 plays its own sound.
      if (asNumber(asset.volume) !== 0) unsupported("a video clip's own audio");
      return {
        kind: 'video',
        src: asString(asset.src) ?? unsupported('video without src'),
        fit: fitOf(clip.fit),
        trimSec: asNumber(asset.trim) ?? 0,
        crop: sideCrop(asset.crop),
      };
    }
    case 'html':
      if (clip.effect !== undefined) unsupported('effect on an html clip');
      return { kind: 'text', card: htmlCard(asset) };
    case 'rich-text': {
      const width = asNumber(clip.width);
      const height = asNumber(clip.height);
      if (!width || !height) return unsupported('rich-text clip without width/height');
      const card = richTextCard(asset, { width, height });
      notes.push(...card.approximations);
      return { kind: 'text', card };
    }
    default:
      return unsupported(`${String(asset.type)} asset`);
  }
}

function placementOf(clip: Json): Placement & { wave: LayerMotion['wave'] } {
  const offset = asRecord(clip.offset) ?? {};
  const x = asNumber(offset.x) ?? (offset.x === undefined ? 0 : unsupported('animated offset.x'));
  let y = 0;
  let wave: LayerMotion['wave'] = null;
  if (Array.isArray(offset.y)) {
    // overlays/shotstack.ts waveTweens: alternating from/to halves of one period.
    const first = asRecord(offset.y[0]) ?? unsupported('offset.y tween');
    const from = asNumber(first.from) ?? 0;
    const to = asNumber(first.to) ?? 0;
    const half = asNumber(first.length) ?? 0.3;
    y = (from + to) / 2;
    wave = { amplitudePx: Math.abs(to - from) / 2, periodSec: half * 2 };
  } else if (offset.y !== undefined) {
    y = asNumber(offset.y) ?? unsupported('offset.y');
  }
  return { position: boxPosition(clip.position), offsetX: x, offsetY: y, wave };
}

interface Timing {
  startSec: number;
  endSec: number;
}

function timingOf(clip: Json): Timing {
  const start = asNumber(clip.start);
  const length = asNumber(clip.length);
  if (start === undefined || start < 0 || !length || length <= 0)
    return unsupported('clip start/length');
  return { startSec: round3(start), endSec: round3(start + length) };
}

function checkKeys(clip: Json): void {
  for (const key of Object.keys(clip)) {
    if (!CLIP_KEYS.has(key)) unsupported(`clip field ${key}`);
  }
}

function transitionsOf(clip: Json): { in?: unknown; out?: unknown } {
  const t = asRecord(clip.transition);
  return t ? { in: t.in, out: t.out } : {};
}

function rotationOf(clip: Json): number {
  const transform = asRecord(clip.transform);
  if (!transform) return 0;
  const rotate = asRecord(transform.rotate);
  const angle = asNumber(rotate?.angle);
  if (Object.keys(transform).some((k) => k !== 'rotate') || angle === undefined)
    return unsupported('clip transform');
  return angle;
}

/** Slide transitions on a layer: where it travels from/to (px) — Shotstack names the travel direction. */
function slideOffset(name: string, frame: { width: number; height: number }) {
  const dx = Math.round(frame.width * 0.25);
  const dy = Math.round(frame.height * 0.15);
  switch (name) {
    case 'slideRight':
      return { dx: -dx, dy: 0 };
    case 'slideLeft':
      return { dx, dy: 0 };
    case 'slideDown':
      return { dx: 0, dy: -dy };
    case 'slideUp':
      return { dx: 0, dy };
    default:
      return null;
  }
}

function layerOf(clip: Json, frame: FrameSpec, notes: string[]): LayerClip {
  checkKeys(clip);
  const timing = timingOf(clip);
  const source = sourceOf(clip, notes);
  const { wave, ...placement } = placementOf(clip);
  const transition = transitionsOf(clip);
  const fade = (value: unknown) => {
    if (value === undefined) return { sec: 0, slide: null };
    const { name, speed } = splitSpeed(asString(value) ?? unsupported('transition'));
    const sec = TRANSITION_SEC[speed];
    const slide = slideOffset(name, frame);
    if (name !== 'fade' && !slide) notes.push(`overlay transition ${name} drawn as a fade`);
    if (slide) notes.push(`overlay ${name} drawn as a short slide with a fade`);
    return { sec, slide: slide && { ...slide, durationSec: sec } };
  };
  const tIn = fade(transition.in);
  const tOut = fade(transition.out);
  let scale: number | null = null;
  let fadeInSec = tIn.sec;
  if (Array.isArray(clip.scale)) {
    // overlays/shotstack.ts scaleTweens (scaleIn / popIn): drawn as a fade over the tween.
    const first = asRecord(clip.scale[0]);
    fadeInSec = Math.max(fadeInSec, asNumber(first?.length) ?? TRANSITION_SEC.plain);
    notes.push('overlay scale-in drawn as a fade');
  } else if (clip.scale !== undefined) {
    scale = asNumber(clip.scale) ?? unsupported('scale');
  }
  if (source.kind === 'text') {
    const animation = asRecord((asRecord(clip.asset) ?? {}).animation);
    if (animation) {
      fadeInSec = Math.max(fadeInSec, asNumber(animation.duration) ?? TRANSITION_SEC.plain);
      notes.push(`text animation ${String(animation.preset)} drawn as a fade`);
    }
  }
  const opacity =
    clip.opacity === undefined ? 1 : (asNumber(clip.opacity) ?? unsupported('opacity'));
  const length = timing.endSec - timing.startSec;
  return {
    ...timing,
    ...placement,
    source,
    scale,
    opacity: Math.min(1, Math.max(0, opacity)),
    fadeInSec: Math.min(fadeInSec, length / 2),
    fadeOutSec: Math.min(tOut.sec, length / 2),
    motion: {
      slideIn: tIn.slide,
      slideOut: tOut.slide,
      wave: wave && { amplitudePx: wave.amplitudePx * frame.height, periodSec: wave.periodSec },
    },
    rotationDeg: rotationOf(clip),
  };
}

function baseOf(clip: Json, notes: string[]): BaseClip {
  checkKeys(clip);
  if (clip.opacity !== undefined && clip.opacity !== 1) unsupported('opacity on the bottom track');
  if (clip.scale !== undefined || clip.transform !== undefined)
    unsupported('scale/transform on the bottom track');
  const { wave, ...placement } = placementOf(clip);
  if (wave) unsupported('animated offset on the bottom track');
  const transition = transitionsOf(clip);
  return {
    ...timingOf(clip),
    ...placement,
    source: sourceOf(clip, notes),
    transitionIn: baseTransition(transition.in, notes),
    transitionOut: baseTransition(transition.out, notes),
  };
}

function audioOf(clip: Json): AudioClip {
  checkKeys(clip);
  const asset = asRecord(clip.asset) ?? unsupported('clip without an asset');
  const { startSec, endSec } = timingOf(clip);
  const length = endSec - startSec;
  const effect = asset.effect;
  const fadeSec = Math.min(AUDIO_FADE_SEC, length / 2);
  if (effect !== undefined && !['fadeIn', 'fadeOut', 'fadeInFadeOut'].includes(String(effect)))
    unsupported(`audio effect ${String(effect)}`);
  return {
    src: asString(asset.src) ?? unsupported('audio without src'),
    startSec,
    lengthSec: round3(length),
    trimSec: asNumber(asset.trim) ?? 0,
    volume: asNumber(asset.volume) ?? 1,
    fadeInSec: effect === 'fadeIn' || effect === 'fadeInFadeOut' ? fadeSec : 0,
    fadeOutSec: effect === 'fadeOut' || effect === 'fadeInFadeOut' ? fadeSec : 0,
  };
}

/** Output size, fps and quality from the edit's `output` (render-presets.ts presetOutput). */
export function frameOf(output: Json): FrameSpec {
  if (output.format !== undefined && output.format !== 'mp4')
    unsupported(`format ${String(output.format)}`);
  const aspect = asString(output.aspectRatio) ?? '16:9';
  if (!['9:16', '16:9', '1:1', '4:5'].includes(aspect)) unsupported(`aspect ratio ${aspect}`);
  const resolution = asString(output.resolution) ?? '1080';
  if (resolution !== '1080' && resolution !== '4k') unsupported(`resolution ${resolution}`);
  const layout = outputDimensions(aspect as AspectRatio, resolution);
  const fps = asNumber(output.fps) ?? 25;
  if (!ALLOWED_FPS.has(fps)) unsupported(`fps ${fps}`);
  const scaleTo = output.scaleTo;
  if (scaleTo !== undefined && scaleTo !== 'hd') unsupported(`scaleTo ${String(scaleTo)}`);
  const k = scaleTo === 'hd' ? 720 / Math.min(layout.width, layout.height) : 1;
  const even = (n: number) => Math.round((n * k) / 2) * 2;
  return {
    ...layout,
    fps,
    outWidth: even(layout.width),
    outHeight: even(layout.height),
    crf: CRF_BY_QUALITY[asString(output.quality) ?? 'high'] ?? CRF_BY_QUALITY.high ?? 20,
  };
}

function isAudioTrack(clips: Json[]): boolean {
  const audio = clips.filter((c) => asRecord(c.asset)?.type === 'audio').length;
  if (audio > 0 && audio < clips.length) unsupported('a track mixing audio and pictures');
  return audio > 0;
}

function noOverlap<T extends { startSec: number; endSec?: number; lengthSec?: number }>(
  items: T[],
  what: string,
): T[] {
  const sorted = [...items].sort((a, b) => a.startSec - b.startSec);
  let end = -Infinity;
  for (const item of sorted) {
    const itemEnd = item.endSec ?? item.startSec + (item.lengthSec ?? 0);
    if (item.startSec < end - 0.001) unsupported(`overlapping ${what}`);
    end = itemEnd;
  }
  return sorted;
}

/** Read a Shotstack edit into the local renderer's timeline (throws NotImplementedError). */
export function readTimeline(edit: Record<string, unknown>): LocalTimeline {
  const timeline = asRecord(edit.timeline) ?? unsupported('edit without a timeline');
  const frame = frameOf(asRecord(edit.output) ?? {});
  const tracks = Array.isArray(timeline.tracks) ? timeline.tracks : [];
  const notes: string[] = [];
  const visualTracks: Json[][] = [];
  const audio: AudioClip[] = [];
  for (const track of tracks) {
    const clips = (asRecord(track)?.clips as unknown[] | undefined) ?? [];
    const records = clips.map((c) => asRecord(c) ?? unsupported('clip'));
    if (records.length === 0) continue;
    if (isAudioTrack(records)) audio.push(...records.map(audioOf));
    else visualTracks.push(records);
  }
  // Tracks are listed top layer first: the last visual track is the bottom one.
  const bottom = visualTracks.pop() ?? [];
  const base = noOverlap(
    bottom.map((c) => baseOf(c, notes)),
    'clips on the bottom track',
  );
  const layers = visualTracks
    .reverse()
    .flatMap((clips) => clips.map((c) => layerOf(c, frame, notes)));
  const ends = [
    ...base.map((c) => c.endSec),
    ...layers.map((c) => c.endSec),
    ...audio.map((c) => c.startSec + c.lengthSec),
  ];
  const totalSec = round3(Math.max(0, ...ends));
  if (totalSec <= 0) unsupported('an empty timeline');
  if (totalSec > MAX_LOCAL_SEC) unsupported(`a ${totalSec}s edit (local limit ${MAX_LOCAL_SEC}s)`);
  const background = asString(timeline.background);
  return {
    frame,
    backdrop: (background && parseColour(background)) || { r: 0, g: 0, b: 0, a: 1 },
    base,
    layers,
    audio: noOverlap(audio, 'audio clips'),
    totalSec,
    notes: [...new Set(notes)],
  };
}
