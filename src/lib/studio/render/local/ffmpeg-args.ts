import { measureFilter, normaliseFilter, type LoudnormMeasurement } from '../../pipeline/mastering';
import { ffmpegColour } from './edit-json';
import type { AudioClip, KenBurns, LayerClip, LocalTimeline, SideCrop } from './timeline';

// BACKLOG 23.5 — the ffmpeg command for one local render (argv only: file names are relative to
// a private temp directory, never interpolated into a shell). Filters and options as documented
// in https://ffmpeg.org/ffmpeg-filters.html (read 2026-10-06):
//   - bottom track: one segment per clip (or backdrop gap), each normalised to the frame size,
//     fps, pixel format and timebase xfade needs ("Both inputs must be constant frame-rate and
//     have the same resolution, pixel format, frame rate and timebase"): setpts, fps, scale /
//     crop (cover = scale force_original_aspect_ratio=increase + centre crop; contain = …decrease
//     + pad), setsar, format, tpad (stop_mode=clone, stop=-1) + trim (end_frame) for an exact
//     frame count, settb (expr). Stills with an effect go through zoompan (z / x / y expressions
//     with the output frame number `on`, d = frames, s = size, fps). Segments are joined with
//     xfade (transition, duration, offset relative to the first input) or concat (a cut); a
//     transition from/to nothing is a fade (type in/out, start_time, duration, color) of the
//     backdrop colour. Gaps are the color source (c, s, r, d).
//   - layers: overlay (x, y expressions with t; eof_action; timeline `enable`) of RGBA images;
//     animated ones are looped image inputs with fade alpha=1 and setpts offset to their start.
//   - audio: per clip atrim/apad (whole_dur) to its length, volume, afade (t, st, d), joined with
//     concat (v=0, a=1) and anullsrc silence; loudnorm (pipeline/mastering.ts: pass 1 measures,
//     pass 2 applies one linear gain to -14 LUFS) when the mix has sound.
// Input options: -loop 1 / -framerate (image2 demuxer), -stream_loop -1 (loop a background
// video shorter than its clip), -ss / -t (ffmpeg main options).

/** A bottom-track clip ready for ffmpeg. */
export type PreparedBase =
  /** A frame-size opaque picture (a still image, a text card on the backdrop). */
  | { readonly kind: 'still'; readonly file: string }
  /** A cover-fitted picture larger than the frame (supersampled) for zoompan. */
  | { readonly kind: 'kenBurns'; readonly file: string; readonly kenBurns: KenBurns }
  | {
      readonly kind: 'video';
      readonly file: string;
      readonly fit: 'cover' | 'contain';
      readonly trimSec: number;
      readonly crop: SideCrop | null;
    };

/** A layer ready for ffmpeg: an RGBA image (or a video) placed at x, y. */
export type PreparedLayer =
  | { readonly kind: 'image'; readonly file: string; readonly x: number; readonly y: number }
  | { readonly kind: 'video'; readonly file: string; readonly fit: 'none' | 'cover' };

export interface PreparedTimeline {
  readonly timeline: LocalTimeline;
  /** One per timeline.base clip, same order. */
  readonly base: readonly PreparedBase[];
  /** One per timeline.layers clip, same order. */
  readonly layers: readonly PreparedLayer[];
  /** One file per timeline.audio clip, same order. */
  readonly audio: readonly string[];
}

const SAMPLE_RATE = 48_000;
const AUDIO_BITRATE = '192k';
/** libx264 speed/size trade-off for the 2 vCPU worker (23.5 target ≤ 15 s for a 15 s 1080p video). */
export const X264_PRESET = 'veryfast';
export const OUTPUT_FILE = 'local-render.mp4';

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

interface Segment {
  readonly clip: number | null; // timeline.base index, or null for a backdrop gap
  readonly startF: number;
  readonly endF: number;
  /** Transition INTO this segment from the previous one (frames, xfade name). */
  readonly inFrames: number;
  readonly xfade: string;
}

/** The bottom track as contiguous segments (clips and backdrop gaps) in frames. */
export function baseSegments(timeline: LocalTimeline): Segment[] {
  const fps = timeline.frame.fps;
  const totalF = Math.round(timeline.totalSec * fps);
  const raw: Array<{ clip: number | null; startF: number; endF: number }> = [];
  let cursor = 0;
  timeline.base.forEach((clip, index) => {
    const startF = Math.max(cursor, Math.round(clip.startSec * fps));
    const endF = Math.min(totalF, Math.round(clip.endSec * fps));
    if (endF <= startF) return;
    if (startF > cursor) raw.push({ clip: null, startF: cursor, endF: startF });
    raw.push({ clip: index, startF, endF });
    cursor = endF;
  });
  if (cursor < totalF) raw.push({ clip: null, startF: cursor, endF: totalF });
  return raw.map((seg, i) => {
    const prev = i > 0 ? raw[i - 1] : undefined;
    const own = seg.clip === null ? null : (timeline.base[seg.clip]?.transitionIn ?? null);
    const prevOut =
      prev && prev.clip !== null ? (timeline.base[prev.clip]?.transitionOut ?? null) : null;
    const t = own ?? prevOut;
    if (!t || !prev) return { ...seg, inFrames: 0, xfade: 'fade' };
    const half = (s: { startF: number; endF: number }) => Math.floor((s.endF - s.startF) / 2);
    const frames = Math.min(Math.round(t.durationSec * fps), half(seg), half(prev));
    return { ...seg, inFrames: Math.max(0, frames), xfade: t.xfade };
  });
}

function normalise(timeline: LocalTimeline, frames: number): string {
  const { width, height, fps } = timeline.frame;
  return [
    'setpts=PTS-STARTPTS',
    `fps=${fps}`,
    `scale=${width}:${height}`,
    'setsar=1',
    'format=yuv420p',
    'tpad=stop_mode=clone:stop=-1',
    `trim=end_frame=${frames}`,
    'setpts=PTS-STARTPTS',
    `settb=expr=1/${fps}`,
  ].join(',');
}

/** zoompan expressions for a Ken Burns move over `frames` output frames. */
export function zoompanFilter(kb: KenBurns, frames: number, timeline: LocalTimeline): string {
  const { width, height, fps } = timeline.frame;
  const p = `on/${Math.max(1, frames - 1)}`;
  const z = 1 + kb.amount;
  const centreX = 'iw/2-(iw/zoom/2)';
  const centreY = 'ih/2-(ih/zoom/2)';
  let zoom = fmt(z);
  let x = centreX;
  let y = centreY;
  switch (kb.move) {
    case 'zoomIn':
      zoom = `1+${fmt(kb.amount)}*${p}`;
      break;
    case 'zoomOut':
      zoom = `${fmt(z)}-${fmt(kb.amount)}*${p}`;
      break;
    case 'slideLeft':
      x = `(iw-iw/zoom)*${p}`;
      break;
    case 'slideRight':
      x = `(iw-iw/zoom)*(1-${p})`;
      break;
    case 'slideUp':
      y = `(ih-ih/zoom)*${p}`;
      break;
    case 'slideDown':
      y = `(ih-ih/zoom)*(1-${p})`;
      break;
  }
  return `zoompan=z='${zoom}':x='${x}':y='${y}':d=${frames}:s=${width}x${height}:fps=${fps}`;
}

function cropFilter(crop: SideCrop | null): string[] {
  if (!crop) return [];
  const w = fmt(1 - crop.left - crop.right);
  const h = fmt(1 - crop.top - crop.bottom);
  return [`crop=iw*${w}:ih*${h}:iw*${fmt(crop.left)}:ih*${fmt(crop.top)}`];
}

function fitFilter(fit: 'cover' | 'contain', timeline: LocalTimeline): string[] {
  const { width, height } = timeline.frame;
  return fit === 'cover'
    ? [`scale=${width}:${height}:force_original_aspect_ratio=increase`, `crop=${width}:${height}`]
    : [
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${ffmpegColour(timeline.backdrop)}`,
      ];
}

class Graph {
  readonly inputs: string[] = [];
  readonly chains: string[] = [];
  private count = 0;
  private labels = 0;

  input(args: string[]): number {
    this.inputs.push(...args);
    this.count += 1;
    return this.count - 1;
  }

  label(prefix: string): string {
    this.labels += 1;
    return `${prefix}${this.labels}`;
  }

  add(chain: string): void {
    this.chains.push(chain);
  }
}

function segmentChain(
  graph: Graph,
  prepared: PreparedTimeline,
  seg: Segment,
  frames: number,
): string {
  const { timeline } = prepared;
  const { width, height, fps } = timeline.frame;
  const sec = fmt(frames / fps);
  const out = graph.label('s');
  const base = seg.clip === null ? null : prepared.base[seg.clip];
  if (!base) {
    graph.add(
      `color=c=${ffmpegColour(timeline.backdrop)}:s=${width}x${height}:r=${fps}:d=${sec},${normalise(timeline, frames)}[${out}]`,
    );
    return out;
  }
  switch (base.kind) {
    case 'still': {
      const k = graph.input(['-loop', '1', '-framerate', String(fps), '-t', sec, '-i', base.file]);
      graph.add(`[${k}:v]${normalise(timeline, frames)}[${out}]`);
      break;
    }
    case 'kenBurns': {
      const k = graph.input(['-i', base.file]);
      graph.add(
        `[${k}:v]${zoompanFilter(base.kenBurns, frames, timeline)},${normalise(timeline, frames)}[${out}]`,
      );
      break;
    }
    case 'video': {
      const k = graph.input([
        '-stream_loop',
        '-1',
        ...(base.trimSec > 0 ? ['-ss', fmt(base.trimSec)] : []),
        '-t',
        sec,
        '-i',
        base.file,
      ]);
      const filters = [...cropFilter(base.crop), ...fitFilter(base.fit, timeline)];
      graph.add(`[${k}:v]${filters.join(',')},${normalise(timeline, frames)}[${out}]`);
      break;
    }
  }
  return out;
}

/** Bottom track: segments joined with xfade / concat; returns the output label. */
function baseChain(graph: Graph, prepared: PreparedTimeline): string {
  const { timeline } = prepared;
  const fps = timeline.frame.fps;
  const backdrop = ffmpegColour(timeline.backdrop);
  const segs = baseSegments(timeline);
  let acc = '';
  segs.forEach((seg, i) => {
    const next = segs[i + 1];
    const frames = seg.endF - seg.startF + (next?.inFrames ?? 0);
    let label = segmentChain(graph, prepared, seg, frames);
    // A transition with nothing before it (first segment) or after it (last) fades the backdrop.
    const clip = seg.clip === null ? null : timeline.base[seg.clip];
    const fades: string[] = [];
    if (i === 0 && clip?.transitionIn) {
      const d = Math.min(Math.round(clip.transitionIn.durationSec * fps), Math.floor(frames / 2));
      if (d > 0) fades.push(`fade=t=in:st=0:d=${fmt(d / fps)}:color=${backdrop}`);
    }
    if (!next && clip?.transitionOut) {
      const d = Math.min(Math.round(clip.transitionOut.durationSec * fps), Math.floor(frames / 2));
      if (d > 0)
        fades.push(`fade=t=out:st=${fmt((frames - d) / fps)}:d=${fmt(d / fps)}:color=${backdrop}`);
    }
    if (fades.length) {
      const faded = graph.label('f');
      graph.add(`[${label}]${fades.join(',')}[${faded}]`);
      label = faded;
    }
    if (i === 0) {
      acc = label;
      return;
    }
    const joined = graph.label('b');
    graph.add(
      seg.inFrames > 0
        ? `[${acc}][${label}]xfade=transition=${seg.xfade}:duration=${fmt(seg.inFrames / fps)}:offset=${fmt(seg.startF / fps)}[${joined}]`
        : `[${acc}][${label}]concat=n=2:v=1:a=0[${joined}]`,
    );
    acc = joined;
  });
  return acc;
}

function animated(layer: LayerClip): boolean {
  return (
    layer.fadeInSec > 0 ||
    layer.fadeOutSec > 0 ||
    layer.motion.slideIn !== null ||
    layer.motion.slideOut !== null ||
    layer.motion.wave !== null
  );
}

/** overlay x / y: the placed position plus slide / wave motion over time (t = seconds). */
export function motionExpr(layer: LayerClip, x: number, y: number): { x: string; y: string } {
  const s = fmt(layer.startSec);
  const e = fmt(layer.endSec);
  const { slideIn, slideOut, wave } = layer.motion;
  const xs = [String(x)];
  const ys = [String(y)];
  if (slideIn) {
    const k = `max(0,1-(t-${s})/${fmt(slideIn.durationSec)})`;
    if (slideIn.dx) xs.push(`${slideIn.dx}*${k}`);
    if (slideIn.dy) ys.push(`${slideIn.dy}*${k}`);
  }
  if (slideOut) {
    const k = `max(0,(t-(${e}-${fmt(slideOut.durationSec)}))/${fmt(slideOut.durationSec)})`;
    if (slideOut.dx) xs.push(`${slideOut.dx}*${k}`);
    if (slideOut.dy) ys.push(`${slideOut.dy}*${k}`);
  }
  // Shotstack offset.y is positive upwards; the overlay y grows downwards.
  if (wave) ys.push(`-${fmt(wave.amplitudePx)}*sin(2*PI*(t-${s})/${fmt(wave.periodSec)})`);
  const sum = (terms: string[]) =>
    terms.reduce((acc, term) => (term.startsWith('-') ? `${acc}${term}` : `${acc}+${term}`));
  return { x: sum(xs), y: sum(ys) };
}

function layerChain(graph: Graph, prepared: PreparedTimeline, acc: string, index: number): string {
  const { timeline } = prepared;
  const layer = timeline.layers[index];
  const prep = prepared.layers[index];
  if (!layer || !prep) return acc;
  const fps = timeline.frame.fps;
  const len = fmt(layer.endSec - layer.startSec);
  const enable = `enable='gte(t,${fmt(layer.startSec)})*lt(t,${fmt(layer.endSec)})'`;
  const out = graph.label('o');
  if (prep.kind === 'video') {
    const k = graph.input(['-t', len, '-i', prep.file]);
    const fit = prep.fit === 'cover' ? `${fitFilter('cover', timeline).join(',')},` : '';
    const v = graph.label('l');
    graph.add(`[${k}:v]${fit}format=rgba,setpts=PTS-STARTPTS+${fmt(layer.startSec)}/TB[${v}]`);
    graph.add(`[${acc}][${v}]overlay=x='(W-w)/2':y='(H-h)/2':eof_action=pass:${enable}[${out}]`);
    return out;
  }
  if (!animated(layer)) {
    const k = graph.input(['-i', prep.file]);
    graph.add(`[${acc}][${k}:v]overlay=x=${prep.x}:y=${prep.y}:${enable}[${out}]`);
    return out;
  }
  const k = graph.input(['-loop', '1', '-framerate', String(fps), '-t', len, '-i', prep.file]);
  const filters = ['format=rgba'];
  if (layer.fadeInSec > 0) filters.push(`fade=t=in:st=0:d=${fmt(layer.fadeInSec)}:alpha=1`);
  if (layer.fadeOutSec > 0) {
    const st = layer.endSec - layer.startSec - layer.fadeOutSec;
    filters.push(`fade=t=out:st=${fmt(st)}:d=${fmt(layer.fadeOutSec)}:alpha=1`);
  }
  filters.push(`setpts=PTS-STARTPTS+${fmt(layer.startSec)}/TB`);
  const v = graph.label('l');
  graph.add(`[${k}:v]${filters.join(',')}[${v}]`);
  const pos = motionExpr(layer, prep.x, prep.y);
  graph.add(`[${acc}][${v}]overlay=x='${pos.x}':y='${pos.y}':eof_action=pass:${enable}[${out}]`);
  return out;
}

function audioClipChain(graph: Graph, clip: AudioClip, file: string): string {
  const len = fmt(clip.lengthSec);
  const k = graph.input([
    ...(clip.trimSec > 0 ? ['-ss', fmt(clip.trimSec)] : []),
    '-t',
    len,
    '-i',
    file,
  ]);
  const filters = [
    `aformat=sample_rates=${SAMPLE_RATE}:channel_layouts=stereo`,
    `apad=whole_dur=${len}`,
    `atrim=duration=${len}`,
    'asetpts=PTS-STARTPTS',
    `volume=${fmt(clip.volume)}`,
  ];
  if (clip.fadeInSec > 0) filters.push(`afade=t=in:st=0:d=${fmt(clip.fadeInSec)}`);
  if (clip.fadeOutSec > 0)
    filters.push(
      `afade=t=out:st=${fmt(clip.lengthSec - clip.fadeOutSec)}:d=${fmt(clip.fadeOutSec)}`,
    );
  const out = graph.label('a');
  graph.add(`[${k}:a]${filters.join(',')}[${out}]`);
  return out;
}

function silence(graph: Graph, sec: number): string {
  const out = graph.label('z');
  graph.add(
    `anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=duration=${fmt(sec)},asetpts=PTS-STARTPTS[${out}]`,
  );
  return out;
}

/** The audio mix (clips in time order with silence between), `extra` filters appended. */
function audioChain(graph: Graph, prepared: PreparedTimeline, extra: string[]): string {
  const { timeline } = prepared;
  const parts: string[] = [];
  let cursor = 0;
  timeline.audio.forEach((clip, i) => {
    const file = prepared.audio[i];
    if (!file) return;
    if (clip.startSec > cursor + 0.001) parts.push(silence(graph, clip.startSec - cursor));
    parts.push(audioClipChain(graph, clip, file));
    cursor = clip.startSec + clip.lengthSec;
  });
  if (parts.length === 0) parts.push(silence(graph, timeline.totalSec));
  const total = fmt(timeline.totalSec);
  const tail = [`apad=whole_dur=${total}`, `atrim=duration=${total}`, ...extra].join(',');
  const out = graph.label('mix');
  graph.add(
    parts.length === 1
      ? `[${parts[0]}]${tail}[${out}]`
      : `${parts.map((p) => `[${p}]`).join('')}concat=n=${parts.length}:v=0:a=1,${tail}[${out}]`,
  );
  return out;
}

/** True when the edit has any sound to normalise (silence is left as is). */
export function hasAudio(timeline: LocalTimeline): boolean {
  return timeline.audio.some((c) => c.volume > 0);
}

/** Pass 1: measure the audio mix's loudness (loudnorm print_format=json), no video. */
export function loudnessArgs(prepared: PreparedTimeline): string[] {
  const graph = new Graph();
  const out = audioChain(graph, prepared, [measureFilter()]);
  return [
    '-hide_banner',
    '-nostdin',
    ...graph.inputs,
    '-filter_complex',
    graph.chains.join(';'),
    '-map',
    `[${out}]`,
    '-f',
    'null',
    '-',
  ];
}

/** Pass 2: the whole render (H.264 + AAC MP4, yuv420p, +faststart). */
export function renderArgs(
  prepared: PreparedTimeline,
  loudness: LoudnormMeasurement | null,
  output = OUTPUT_FILE,
): string[] {
  const { timeline } = prepared;
  const { frame } = timeline;
  const graph = new Graph();
  let video = baseChain(graph, prepared);
  timeline.layers.forEach((_, i) => {
    video = layerChain(graph, prepared, video, i);
  });
  const vout = graph.label('vout');
  const scale =
    frame.outWidth !== frame.width || frame.outHeight !== frame.height
      ? `scale=${frame.outWidth}:${frame.outHeight},`
      : '';
  graph.add(`[${video}]${scale}format=yuv420p[${vout}]`);
  const aout = audioChain(graph, prepared, loudness ? [normaliseFilter(loudness)] : []);
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    ...graph.inputs,
    '-filter_complex',
    graph.chains.join(';'),
    '-map',
    `[${vout}]`,
    '-map',
    `[${aout}]`,
    '-c:v',
    'libx264',
    '-preset',
    X264_PRESET,
    '-crf',
    String(frame.crf),
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(frame.fps),
    '-c:a',
    'aac',
    '-b:a',
    AUDIO_BITRATE,
    '-ar',
    String(SAMPLE_RATE),
    '-movflags',
    '+faststart',
    '-t',
    fmt(timeline.totalSec),
    output,
  ];
}
