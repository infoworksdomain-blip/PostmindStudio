import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigurationError, UpstreamServiceError } from '../../errors';
import { run } from '../pipeline/media-probe';
import type { AssetStorage } from '../storage';
import { fontPx, splitColour, type FrameSize, type OverlayRow } from './shotstack';

// BACKLOG 8.4 / Addendum A4.6 — overlays Shotstack can't animate natively (glitch, karaoke
// word highlight, counter) are rendered by FFmpeg to a transparent overlay and composited as a
// video clip. Shotstack composites alpha from MOV (its docs; WEBM alpha is reported unsupported),
// so the output is ProRes 4444 with alpha. Text reaches FFmpeg only through textfile= (no
// filtergraph escaping of user text) and the process runs with an argv array in a private temp
// directory, so user input never touches a shell or a path.

const FPS = 30;
const RENDER_TIMEOUT_MS = 2 * 60_000;
const COUNTER_DEFAULT_SEC = 1.5;

export interface PreRenderFiles {
  /** Relative names inside the working directory. */
  font: string;
  texts: string[];
}

/** FFmpeg colour from #RRGGBB[AA]: 0xRRGGBB@alpha (ffmpeg-utils colour syntax). */
export function ffColour(hex: string): string {
  const { color, opacity } = splitColour(hex);
  return `0x${color.slice(1)}@${opacity}`;
}

function xExpr(overlay: OverlayRow): string {
  const ax = overlay.anchorX.toFixed(4);
  if (overlay.alignment === 'left' || overlay.animationIn === 'karaokeHighlight') return `w*${ax}`;
  if (overlay.alignment === 'right') return `w*${ax}-tw`;
  return `w*${ax}-tw/2`;
}

function yExpr(overlay: OverlayRow): string {
  return `h*${overlay.anchorY.toFixed(4)}-th/2`;
}

function drawtext(parts: Record<string, string | number>): string {
  return `drawtext=${Object.entries(parts)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? v : `'${v}'`}`)
    .join(':')}`;
}

/** The number a counter counts to: effect.counterTo, else the first number in the text. */
export function counterTarget(overlay: OverlayRow): { from: number; to: number; suffix: string } {
  const match = overlay.text.match(/-?\d+(\.\d+)?/);
  const to = overlay.effect?.counterTo ?? (match ? Number(match[0]) : 0);
  const suffix = match ? overlay.text.slice((match.index ?? 0) + match[0].length) : '';
  return { from: overlay.effect?.counterFrom ?? 0, to, suffix };
}

/**
 * Per-word highlight times: the spoken timing when the narration was transcribed (13.6,
 * overlays/word-timing.ts), otherwise spread evenly across the overlay.
 */
export function karaokeSteps(
  text: string,
  durationSec: number,
  wordStartsSec?: number[],
): Array<{ prefix: string; at: number }> {
  const words = text.split(/\s+/).filter(Boolean);
  const spoken = wordStartsSec && wordStartsSec.length === words.length ? wordStartsSec : null;
  const step = durationSec / Math.max(1, words.length);
  return words.map((_, i) => ({
    prefix: words.slice(0, i + 1).join(' '),
    at: spoken ? (spoken[i] ?? 0) : Math.round(i * step * 1000) / 1000,
  }));
}

/** Text files the filter reads, in order. */
export function preRenderTexts(overlay: OverlayRow): string[] {
  const duration = overlay.endAtSec - overlay.startAtSec;
  if (overlay.animationIn === 'counter') {
    const { from, to, suffix } = counterTarget(overlay);
    const d = Math.min(
      duration,
      overlay.animationInMs > 0 ? overlay.animationInMs / 1000 : COUNTER_DEFAULT_SEC,
    );
    // %{eif:…} is FFmpeg's documented text expansion; the file is read with expansion=normal.
    const escapedSuffix = suffix.replace(/\\/g, '\\\\').replace(/%/g, '\\%');
    return [`%{eif:trunc(${from}+(${to - from})*min(1,t/${d.toFixed(3)})):d}${escapedSuffix}`];
  }
  if (overlay.animationIn === 'karaokeHighlight') {
    return [
      overlay.text,
      ...karaokeSteps(overlay.text, duration, overlay.wordStartsSec).map((s) => s.prefix),
    ];
  }
  return [overlay.text];
}

export function buildPreRenderArgs(
  overlay: OverlayRow,
  frame: FrameSize,
  files: PreRenderFiles,
  output: string,
): string[] {
  const duration = Math.max(0.1, overlay.endAtSec - overlay.startAtSec);
  const size = fontPx(overlay, frame);
  const base = { fontfile: files.font, fontsize: size, x: xExpr(overlay), y: yExpr(overlay) };
  const stroke: Record<string, string | number> =
    overlay.strokeColor && overlay.strokeWidthPx
      ? { borderw: Math.round(overlay.strokeWidthPx), bordercolor: ffColour(overlay.strokeColor) }
      : {};
  const filters: string[] = [];
  const [first = 'main.txt', ...rest] = files.texts;

  if (overlay.animationIn === 'glitch') {
    const intensity = (overlay.effect?.glitchIntensity ?? 0.5) * 30;
    const jitter = (seed: number) =>
      `+if(lt(t,0.5),(random(${seed})-0.5)*${intensity.toFixed(1)},0)`;
    filters.push(
      drawtext({
        ...base,
        textfile: first,
        expansion: 'none',
        fontcolor: '0xFF0040@0.8',
        x: `${xExpr(overlay)}-4${jitter(1)}`,
      }),
      drawtext({
        ...base,
        textfile: first,
        expansion: 'none',
        fontcolor: '0x00E5FF@0.8',
        x: `${xExpr(overlay)}+4${jitter(2)}`,
      }),
      drawtext({
        ...base,
        ...stroke,
        textfile: first,
        expansion: 'none',
        fontcolor: ffColour(overlay.fillColor),
      }),
    );
  } else if (overlay.animationIn === 'karaokeHighlight') {
    const steps = karaokeSteps(overlay.text, duration, overlay.wordStartsSec);
    filters.push(
      drawtext({
        ...base,
        ...stroke,
        textfile: first,
        expansion: 'none',
        fontcolor: '0xFFFFFF@0.6',
      }),
    );
    rest.forEach((file, i) => {
      const from = steps[i]?.at ?? 0;
      filters.push(
        drawtext({
          ...base,
          textfile: file,
          expansion: 'none',
          fontcolor: ffColour(overlay.fillColor),
          enable: `between(t,${from},${duration})`,
        }),
      );
    });
  } else {
    filters.push(
      drawtext({
        ...base,
        ...stroke,
        textfile: first,
        expansion: overlay.animationIn === 'counter' ? 'normal' : 'none',
        fontcolor: ffColour(overlay.fillColor),
      }),
    );
  }

  return [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=black@0.0:s=${frame.width}x${frame.height}:r=${FPS}:d=${duration.toFixed(3)},format=rgba`,
    '-vf',
    filters.join(','),
    '-c:v',
    'prores_ks',
    '-profile:v',
    '4444',
    '-pix_fmt',
    'yuva444p10le',
    '-an',
    output,
  ];
}

export interface PreRenderDeps {
  storage: AssetStorage;
  bucket: string;
  fetchImpl: typeof fetch;
  fontsBaseUrl: string | undefined;
  ffmpegPath?: string;
}

/** Deterministic key: identical overlays on identical frames are rendered once. */
export function preRenderKey(
  organisationId: string,
  overlay: OverlayRow,
  frame: FrameSize,
): string {
  const { id: _id, ...content } = overlay;
  void _id;
  const hash = createHash('sha256').update(JSON.stringify({ content, frame })).digest('hex');
  return `orgs/${organisationId}/overlays/${hash}.mov`;
}

export async function preRenderOverlay(
  deps: PreRenderDeps,
  organisationId: string,
  overlay: OverlayRow,
  frame: FrameSize,
): Promise<string> {
  const key = preRenderKey(organisationId, overlay, frame);
  const cached = await deps.storage.size(deps.bucket, key).catch(() => 0);
  if (cached > 0) return deps.storage.signedUrl(deps.bucket, key);
  if (!deps.fontsBaseUrl) {
    throw new ConfigurationError('STUDIO_FONTS_BASE_URL is required to render text overlays');
  }
  const fontUrl = `${deps.fontsBaseUrl.replace(/\/$/, '')}/${encodeURIComponent(overlay.fontFamily.replace(/ /g, ''))}.ttf`;
  const fontRes = await deps.fetchImpl(fontUrl, { signal: AbortSignal.timeout(30_000) });
  if (!fontRes.ok)
    throw new UpstreamServiceError(`Font ${overlay.fontFamily} could not be downloaded`);

  const dir = await mkdtemp(join(tmpdir(), 'studio-overlay-'));
  try {
    await writeFile(join(dir, 'font.ttf'), new Uint8Array(await fontRes.arrayBuffer()));
    const texts = preRenderTexts(overlay);
    const names = texts.map((_, i) => `t${i}.txt`);
    await Promise.all(
      texts.map((text, i) => writeFile(join(dir, names[i] as string), text, 'utf8')),
    );
    const args = buildPreRenderArgs(overlay, frame, { font: 'font.ttf', texts: names }, 'out.mov');
    const result = await run(
      deps.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg',
      args,
      RENDER_TIMEOUT_MS,
      dir,
    );
    if (result.code !== 0) {
      throw new UpstreamServiceError(`Overlay pre-render failed: ${result.stderr.slice(-500)}`);
    }
    const stored = await deps.storage.put({
      bucket: deps.bucket,
      key,
      body: new Uint8Array(await readFile(join(dir, 'out.mov'))),
      contentType: 'video/quicktime',
    });
    return stored.url;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
