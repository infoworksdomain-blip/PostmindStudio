import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import sharp from 'sharp';
import { overlayCss } from '../../src/components/studio/overlays/overlay-frame';
import { makeOverlay } from '../../src/components/studio/overlays/test-fixtures';
import type { Overlay } from '../../src/components/studio/overlays/types';
import { resolveStyle, PRE_RENDERED_ANIMATIONS } from '../../src/lib/studio/overlays/params';
import { preRenderOverlay } from '../../src/lib/studio/overlays/prerender';
import { BUILT_IN_PRESETS, type BuiltInPreset } from '../../src/lib/studio/overlays/presets';
import type { FrameSize, OverlayRow } from '../../src/lib/studio/overlays/shotstack';
import { memoryStorage } from '../helpers/memory-storage';

// BACKLOG 15.D10 / A14.2 "Overlay editor pixel-diff CI passes against reference renders for all
// 25 built-in presets". Per built-in preset (overlays/presets.ts) this harness renders:
//   1. the HTML preview — the editor's own overlayCss() in headless Chromium (Playwright);
//   2. the FFmpeg pre-render — the production preRenderOverlay() (overlays/prerender.ts), last
//      frame extracted once the entry animation has settled;
//   3. the Shotstack reference — test/visual/references/<preset key>.png, captured by the
//      operator on the first live run (runbooks/slo-and-launch-readiness.md).
// and diffs them on black. Tools it needs (ffmpeg, Playwright + Chromium, the preset font files)
// are not dependencies of the repo; when one is missing the suite is skipped with the reason.

export const FRAME: FrameSize = { width: 540, height: 960 };
export const SAMPLE_TEXT = 'Save 42% today';
/** Overlay visible 0–2 s; frames are compared at 1.9 s, after every entry animation. */
export const OVERLAY_SECONDS = 2;
export const SETTLED_AT_SEC = 1.9;
/** A channel difference above this counts the pixel as different (anti-aliasing noise). */
export const CHANNEL_TOLERANCE = 48;
export const DEFAULT_MAX_DIFF_RATIO = 0.02;
export const REFERENCES_DIR = fileURLToPath(new URL('./references/', import.meta.url));

export interface PresetCase {
  key: string;
  name: string;
  row: OverlayRow;
  preview: Overlay;
  /** The FFmpeg path is production for these; for the rest it is a local proxy renderer. */
  preRendered: boolean;
}

export function presetCases(presets: BuiltInPreset[] = BUILT_IN_PRESETS): PresetCase[] {
  return presets.map((preset) => {
    const style = resolveStyle(preset.parameters);
    const timing = { text: SAMPLE_TEXT, startAtSec: 0, endAtSec: OVERLAY_SECONDS };
    return {
      key: preset.key,
      name: preset.name,
      row: { ...style, ...timing, id: `visual_${preset.key}` },
      preview: makeOverlay({ ...style, ...timing, id: `visual_${preset.key}` } as Partial<Overlay>),
      preRendered: PRE_RENDERED_ANIMATIONS.has(style.animationIn),
    };
  });
}

/** Font file name the pre-render fetches: STUDIO_FONTS_BASE_URL/<Family without spaces>.ttf. */
export const fontFileName = (family: string) => `${family.replace(/ /g, '')}.ttf`;

/** The HTML preview page: one frame, the overlay styled exactly as the editor styles it. */
export function previewHtml(overlay: Overlay, frame: FrameSize, fontDataUrl: string): string {
  const text = createElement(
    'span',
    {
      style: {
        ...overlayCss(overlay),
        position: 'absolute',
        maxWidth: '90%',
        whiteSpace: 'pre-wrap',
      },
    },
    overlay.text,
  );
  const body = renderToStaticMarkup(
    createElement(
      'div',
      {
        id: 'frame',
        style: {
          position: 'relative',
          width: `${frame.width}px`,
          height: `${frame.height}px`,
          overflow: 'hidden',
          containerType: 'size',
        },
      },
      text,
    ),
  );
  const family = overlay.fontFamily.replace(/'/g, '');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: '${family}'; src: url(${fontDataUrl}) format('truetype'); font-weight: 100 900; }
html, body { margin: 0; background: transparent; }
</style></head><body>${body}</body></html>`;
}

/** Share of pixels that differ by more than CHANNEL_TOLERANCE in any RGB channel. */
export function diffRatio(a: Uint8Array, b: Uint8Array, channels: number): number {
  if (a.length !== b.length) throw new RangeError('images differ in size');
  const pixels = a.length / channels;
  let different = 0;
  for (let i = 0; i < a.length; i += channels) {
    for (let c = 0; c < Math.min(channels, 3); c += 1) {
      if (Math.abs((a[i + c] ?? 0) - (b[i + c] ?? 0)) > CHANNEL_TOLERANCE) {
        different += 1;
        break;
      }
    }
  }
  return pixels === 0 ? 0 : different / pixels;
}

/** Both PNGs flattened onto black at the frame size, then compared. */
export async function pngDiffRatio(a: Buffer, b: Buffer, frame: FrameSize): Promise<number> {
  const raw = (png: Buffer) =>
    sharp(png)
      .resize(frame.width, frame.height, { fit: 'fill' })
      .flatten({ background: '#000000' })
      .removeAlpha()
      .raw()
      .toBuffer();
  const [ra, rb] = await Promise.all([raw(a), raw(b)]);
  return diffRatio(ra, rb, 3);
}

export function maxDiffRatio(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.VISUAL_MAX_DIFF_RATIO);
  return Number.isFinite(value) && value > 0 && value < 1 ? value : DEFAULT_MAX_DIFF_RATIO;
}

// ---- environment ---------------------------------------------------------------------------

/** Minimal surface of Playwright's chromium used here (Playwright is not a repo dependency). */
interface Page {
  setContent(html: string): Promise<void>;
  evaluate<T>(fn: () => T): Promise<T>;
  locator(selector: string): { screenshot(options: { omitBackground: boolean }): Promise<Buffer> };
}
export interface Browser {
  newPage(options: { viewport: { width: number; height: number } }): Promise<Page>;
  close(): Promise<void>;
}

export interface VisualEnv {
  ffmpeg: string;
  fontsDir: string;
  launch: () => Promise<Browser>;
}

function ffmpegBinary(env: Record<string, string | undefined>): string | null {
  const bin = env.FFMPEG_PATH?.trim() || 'ffmpeg';
  const probe = spawnSync(bin, ['-version'], { stdio: 'ignore' });
  return probe.status === 0 ? bin : null;
}

/** Everything the pixel diff needs, or the reason it has to be skipped. */
export async function visualEnv(
  env: Record<string, string | undefined> = process.env,
): Promise<VisualEnv | { skip: string }> {
  const ffmpeg = ffmpegBinary(env);
  if (!ffmpeg) return { skip: 'ffmpeg is not installed (set FFMPEG_PATH or install ffmpeg)' };
  const fontsDir = env.VISUAL_FONTS_DIR?.trim();
  if (!fontsDir || !existsSync(fontsDir)) {
    return { skip: 'VISUAL_FONTS_DIR is not set (a folder with the preset fonts as <Family>.ttf)' };
  }
  const missing = [...new Set(presetCases().map((c) => fontFileName(c.row.fontFamily)))].filter(
    (f) => !existsSync(join(fontsDir, f)),
  );
  if (missing.length > 0) return { skip: `VISUAL_FONTS_DIR is missing ${missing.join(', ')}` };
  const moduleName = 'playwright';
  let chromium: { launch(): Promise<Browser> };
  try {
    ({ chromium } = (await import(/* @vite-ignore */ moduleName)) as {
      chromium: { launch(): Promise<Browser> };
    });
  } catch {
    return {
      skip: 'Playwright is not installed (npm i --no-save playwright; npx playwright install chromium)',
    };
  }
  return { ffmpeg, fontsDir, launch: () => chromium.launch() };
}

// ---- renderers -----------------------------------------------------------------------------

export async function renderPreview(
  browser: Browser,
  c: PresetCase,
  fontsDir: string,
): Promise<Buffer> {
  const font = readFileSync(join(fontsDir, fontFileName(c.row.fontFamily)));
  const page = await browser.newPage({ viewport: { ...FRAME } });
  await page.setContent(
    previewHtml(c.preview, FRAME, `data:font/ttf;base64,${font.toString('base64')}`),
  );
  await page.evaluate(() => document.fonts.ready.then(() => true));
  return page.locator('#frame').screenshot({ omitBackground: true });
}

/** The production pre-render (fonts served from fontsDir), then its settled frame as PNG. */
export async function renderFfmpeg(visual: VisualEnv, c: PresetCase): Promise<Buffer> {
  const { storage, objects } = memoryStorage();
  const localFonts: typeof fetch = async (input) => {
    const name = decodeURIComponent(String(input).split('/').pop() ?? '');
    const path = join(visual.fontsDir, name);
    return existsSync(path)
      ? new Response(new Uint8Array(readFileSync(path)))
      : new Response('missing', { status: 404 });
  };
  await preRenderOverlay(
    {
      storage,
      bucket: 'visual',
      fetchImpl: localFonts,
      fontsBaseUrl: 'https://fonts.visual.local',
      ffmpegPath: visual.ffmpeg,
    },
    'org_visual',
    c.row,
    FRAME,
  );
  const mov = [...objects.values()][0]?.body;
  if (!mov) throw new RangeError(`pre-render produced nothing for ${c.key}`);
  const dir = await mkdtemp(join(tmpdir(), 'studio-visual-'));
  try {
    await writeFile(join(dir, 'in.mov'), mov);
    const out = spawnSync(
      visual.ffmpeg,
      [
        '-hide_banner',
        '-y',
        '-ss',
        String(SETTLED_AT_SEC),
        '-i',
        'in.mov',
        '-frames:v',
        '1',
        'frame.png',
      ],
      { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    if (out.status !== 0)
      throw new RangeError(`frame extract failed: ${String(out.stderr).slice(-300)}`);
    return await readFile(join(dir, 'frame.png'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function referencePng(key: string): Buffer | null {
  const path = join(REFERENCES_DIR, `${key}.png`);
  return existsSync(path) ? readFileSync(path) : null;
}
