// Sample media for the demo build. The artifact page can't load images or video from other hosts,
// so every picture is a data: URL and every video is a short canvas animation recorded in the
// browser with MediaRecorder (blob: URL). All of it is labelled as sample media.
//
// 25 polish: render posters (the review player, variant cards, analytics, Blitz and the calendar
// preview) are the real Studio-made showcase posters (public/marketing/studio, already inlined for
// the landing page, so they add nothing to the bundle), with the same SAMPLE mark.
//
// Phase 20.8: the photographic scenes are real photos (Unsplash licence, listed in
// public/marketing/SOURCES.md), inlined by the build through @/lib/marketing/media-src; each is
// cropped to the requested size on a canvas with the SAMPLE mark, and the sample videos pan and zoom
// slowly across the same photo. The brand-kit logo is an original SVG. The earlier canvas drawings
// remain as the fallback while a photo decodes (and for the "studio" wordmark).

import {
  MARKETING_PHOTOS,
  STUDIO_CLIPS,
  type MarketingPhoto,
  type StudioClipName,
} from '@/lib/marketing/media';
import { marketingSrc } from '@/lib/marketing/media-src';

export type SceneKind =
  | 'sourdough'
  | 'croissant'
  | 'coffee'
  | 'storefront'
  | 'baker'
  | 'flatlay'
  | 'cake'
  | 'market'
  | 'logo'
  | 'street'
  | 'kitchen'
  | 'studio';

interface Palette {
  sky: [string, string];
  accent: string;
  ink: string;
}

const PALETTES: Record<SceneKind, Palette> = {
  sourdough: { sky: ['#f3d9b1', '#c98b4a'], accent: '#8a4b1f', ink: '#3b2112' },
  croissant: { sky: ['#fbe7c6', '#e7a857'], accent: '#b86a1c', ink: '#40240d' },
  coffee: { sky: ['#e8d5c4', '#7a5238'], accent: '#3d2618', ink: '#1f130b' },
  storefront: { sky: ['#cfe3e6', '#6f9aa3'], accent: '#c2452d', ink: '#1d2f33' },
  baker: { sky: ['#f1e2d3', '#b48c6a'], accent: '#e8e0d6', ink: '#2e2018' },
  flatlay: { sky: ['#efe9df', '#cdbfa8'], accent: '#a3542c', ink: '#2c241a' },
  cake: { sky: ['#f8dfe4', '#d68fa0'], accent: '#fff4f0', ink: '#4a1f2a' },
  market: { sky: ['#e3ecd4', '#89a36a'], accent: '#d9822b', ink: '#26311a' },
  logo: { sky: ['#1f1a17', '#3a302a'], accent: '#e2552f', ink: '#fbf6ee' },
  street: { sky: ['#dde3ea', '#8392a6'], accent: '#e2552f', ink: '#1c2330' },
  kitchen: { sky: ['#ece6dc', '#a6978a'], accent: '#5c7a6b', ink: '#231d18' },
  studio: { sky: ['#20242b', '#454c57'], accent: '#e2552f', ink: '#f4efe7' },
};

/** The photo behind each photographic scene (logo and studio are drawn, not photographed). */
const SCENE_PHOTOS: Partial<Record<SceneKind, MarketingPhoto>> = {
  sourdough: 'sourdoughLoaf',
  croissant: 'croissants',
  coffee: 'coffee',
  storefront: 'sourdoughBoard',
  baker: 'sourdoughHands',
  flatlay: 'breakfast',
  cake: 'cake',
  market: 'marketStall',
  street: 'doughKneading',
  kitchen: 'doughBalls',
};

const photoCache = new Map<MarketingPhoto, HTMLImageElement>();

/** The decoded photo for a scene, or null (no photo, not decoded yet, or no DOM). */
function scenePhoto(kind: SceneKind): HTMLImageElement | null {
  const name = SCENE_PHOTOS[kind];
  if (!name || typeof Image === 'undefined') return null;
  let img = photoCache.get(name);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.src = marketingSrc(MARKETING_PHOTOS[name].path);
    photoCache.set(name, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/** Showcase posters for a made video, food and the high street first (the sample is a bakery). */
export const VIDEO_POSTERS: readonly StudioClipName[] = [
  'northsideBakery',
  'seedanceBread',
  'harbourCoffee',
  'seedanceMarket',
  'greenleafFlorist',
  'atelierWren',
  'coastlineStays',
  'pulseStudio',
];
/** Showcase posters for a wall-of-text video. */
export const WALL_OF_TEXT_POSTERS: readonly StudioClipName[] = [
  'pulseStudioText',
  'coastlineStaysText',
];

export type PosterKind = 'video' | 'wall_of_text';

/** The showcase poster for `seed` (a project id): the same one every time. */
export function posterClipFor(seed: string, kind: PosterKind = 'video'): StudioClipName {
  const list = kind === 'wall_of_text' ? WALL_OF_TEXT_POSTERS : VIDEO_POSTERS;
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return list[hash % list.length] ?? 'northsideBakery';
}

/** The poster file's URL (the 360 px WebP; the demo build inlines the 720 px one for it). */
export function posterSrc(name: StudioClipName): string {
  return marketingSrc(STUDIO_CLIPS[name].poster.small.path);
}

const posterImages = new Map<StudioClipName, HTMLImageElement>();
const posterCache = new Map<StudioClipName, string>();

function posterImage(name: StudioClipName): HTMLImageElement | null {
  if (typeof Image === 'undefined') return null;
  let img = posterImages.get(name);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.src = posterSrc(name);
    posterImages.set(name, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/** Poster size (9:16, as the showcase posters are). */
const POSTER_W = 360;
const POSTER_H = 640;

/**
 * A sample render poster: the showcase poster for `seed` with the SAMPLE mark, or the plain poster
 * file while it is still decoding (and where there is no canvas).
 */
export function samplePoster(seed: string, kind: PosterKind = 'video'): string {
  const name = posterClipFor(seed, kind);
  const hit = posterCache.get(name);
  if (hit) return hit;
  const img = posterImage(name);
  if (!img) return posterSrc(name);
  try {
    const [canvas, ctx] = ctx2d(POSTER_W, POSTER_H);
    drawCover(ctx, img, POSTER_W, POSTER_H, 0);
    sampleMark(ctx, POSTER_W, POSTER_H);
    const url = canvas.toDataURL('image/jpeg', 0.85);
    posterCache.set(name, url);
    return url;
  } catch {
    return posterSrc(name);
  }
}

/** Start decoding every scene photo and showcase poster (the demo opens on the landing page, long
 *  before a screen asks for a thumbnail). */
export function preloadScenePhotos(): void {
  for (const kind of Object.keys(SCENE_PHOTOS) as SceneKind[]) scenePhoto(kind);
  for (const name of [...VIDEO_POSTERS, ...WALL_OF_TEXT_POSTERS]) posterImage(name);
}

/** Draw `img` to cover w×h; `t` (seconds) drives a slow zoom and pan for the sample videos. */
function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
  t: number,
): void {
  const zoom = 1 + Math.min(t, 8) * 0.012;
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight) * zoom;
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  const pan = Math.sin(t * 0.35) * 0.5 + 0.5;
  ctx.drawImage(img, (w - dw) * pan, (h - dh) / 2, dw, dh);
}

/** Original brand-kit logo for the sample business (a wheat ear in a roundel and the name). */
function logoSvg(w: number, h: number): string {
  const ear = [0, 1, 2, 3]
    .map((i) => {
      const y = 46 - i * 9;
      return `<path d="M60 ${y} q-12 -2 -15 -13 q12 1 15 13z"/><path d="M60 ${y} q12 -2 15 -13 q-12 1 -15 13z"/>`;
    })
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 400 400">
<rect width="400" height="400" fill="#1f1a17"/>
<g transform="translate(140 70) scale(1)"><circle cx="60" cy="50" r="56" fill="none" stroke="#e2552f" stroke-width="4"/>
<g fill="#fbf6ee">${ear}<rect x="58" y="44" width="4" height="46" rx="2"/></g></g>
<text x="200" y="262" text-anchor="middle" font-family="Georgia, 'Instrument Serif', serif" font-style="italic" font-size="52" fill="#fbf6ee">Leeds Sourdough</text>
<text x="200" y="304" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="15" letter-spacing="6" fill="#e2552f">BAKERY · EST. 2019</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function ctx2d(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  return [canvas, ctx];
}

function loaf(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, p: Palette) {
  const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.4, r * 0.1, x, y, r * 1.2);
  g.addColorStop(0, '#e9b877');
  g.addColorStop(0.6, p.accent);
  g.addColorStop(1, p.ink);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(x, y, r * 1.35, r, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,236,200,0.75)';
  ctx.lineWidth = Math.max(2, r * 0.06);
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(x - r * 0.7 + i * r * 0.35, y - r * 0.55);
    ctx.quadraticCurveTo(x + i * r * 0.35, y - r * 0.1, x + r * 0.2 + i * r * 0.35, y + r * 0.55);
    ctx.stroke();
  }
}

function cup(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, p: Palette) {
  ctx.fillStyle = '#f7f1ea';
  ctx.beginPath();
  ctx.ellipse(x, y, r * 1.5, r * 1.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = p.ink;
  ctx.beginPath();
  ctx.ellipse(x, y, r, r, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(247,241,234,0.8)';
  ctx.lineWidth = r * 0.12;
  ctx.beginPath();
  ctx.moveTo(x - r * 0.3, y + r * 0.2);
  ctx.bezierCurveTo(x - r * 0.3, y - r * 0.5, x + r * 0.3, y - r * 0.5, x, y + r * 0.35);
  ctx.bezierCurveTo(x - r * 0.1, y - r * 0.2, x + r * 0.25, y - r * 0.2, x + r * 0.3, y + r * 0.2);
  ctx.stroke();
}

function croissant(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, p: Palette) {
  for (let i = -2; i <= 2; i++) {
    const g = ctx.createLinearGradient(x, y - r, x, y + r);
    g.addColorStop(0, '#f2c27c');
    g.addColorStop(1, p.accent);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(
      x + i * r * 0.42,
      y + Math.abs(i) * r * 0.18,
      r * 0.32,
      r * (0.62 - Math.abs(i) * 0.1),
      i * 0.35,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
}

function storefront(ctx: CanvasRenderingContext2D, w: number, h: number, p: Palette) {
  ctx.fillStyle = '#efe6d8';
  ctx.fillRect(w * 0.12, h * 0.25, w * 0.76, h * 0.65);
  ctx.fillStyle = p.accent;
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = i % 2 ? p.accent : '#f6efe4';
    ctx.fillRect(w * 0.12 + (i * w * 0.76) / 8, h * 0.25, (w * 0.76) / 8, h * 0.08);
  }
  ctx.fillStyle = 'rgba(40,60,70,0.55)';
  ctx.fillRect(w * 0.18, h * 0.4, w * 0.38, h * 0.3);
  ctx.fillRect(w * 0.62, h * 0.4, w * 0.2, h * 0.5);
  loaf(ctx, w * 0.3, h * 0.62, Math.min(w, h) * 0.05, PALETTES.sourdough);
  loaf(ctx, w * 0.44, h * 0.64, Math.min(w, h) * 0.045, PALETTES.sourdough);
}

function wordmark(ctx: CanvasRenderingContext2D, w: number, h: number, p: Palette, text: string) {
  ctx.fillStyle = p.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `italic ${Math.round(Math.min(w, h) * 0.16)}px "Instrument Serif", Georgia, serif`;
  ctx.fillText(text, w / 2, h / 2);
  ctx.fillStyle = p.accent;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2 + Math.min(w, h) * 0.16, Math.min(w, h) * 0.02, 0, Math.PI * 2);
  ctx.fill();
}

function paintScene(
  ctx: CanvasRenderingContext2D,
  kind: SceneKind,
  w: number,
  h: number,
  t = 0,
): void {
  const p = PALETTES[kind];
  const photo = scenePhoto(kind);
  if (photo) {
    drawCover(ctx, photo, w, h, t);
    sampleMark(ctx, w, h);
    return;
  }
  const g = ctx.createLinearGradient(0, 0, w * Math.cos(t * 0.4) * 0.3 + w * 0.3, h);
  g.addColorStop(0, p.sky[0]);
  g.addColorStop(1, p.sky[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // soft table / light
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.beginPath();
  ctx.ellipse(w * (0.3 + 0.05 * Math.sin(t)), h * 0.2, w * 0.5, h * 0.18, -0.4, 0, Math.PI * 2);
  ctx.fill();
  const m = Math.min(w, h);
  const bob = Math.sin(t * 1.3) * m * 0.01;
  switch (kind) {
    case 'sourdough':
    case 'market':
      loaf(ctx, w * 0.5, h * 0.58 + bob, m * 0.2, p);
      loaf(ctx, w * 0.25, h * 0.72, m * 0.1, p);
      break;
    case 'croissant':
    case 'flatlay':
      croissant(ctx, w * 0.5, h * 0.55 + bob, m * 0.28, p);
      if (kind === 'flatlay') cup(ctx, w * 0.78, h * 0.25, m * 0.08, PALETTES.coffee);
      break;
    case 'coffee':
      cup(ctx, w * 0.5, h * 0.55 + bob, m * 0.16, p);
      break;
    case 'storefront':
    case 'street':
      storefront(ctx, w, h, p);
      break;
    case 'cake': {
      ctx.fillStyle = p.accent;
      ctx.fillRect(w * 0.3, h * 0.45 + bob, w * 0.4, h * 0.25);
      ctx.fillStyle = '#d4566f';
      ctx.fillRect(w * 0.3, h * 0.52 + bob, w * 0.4, h * 0.03);
      break;
    }
    case 'baker':
    case 'kitchen': {
      ctx.fillStyle = p.ink;
      ctx.beginPath();
      ctx.arc(w * 0.5, h * 0.36 + bob, m * 0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = p.accent;
      ctx.fillRect(w * 0.36, h * 0.47 + bob, w * 0.28, h * 0.35);
      loaf(ctx, w * 0.5, h * 0.62 + bob, m * 0.09, PALETTES.sourdough);
      break;
    }
    case 'logo':
      wordmark(ctx, w, h, p, 'Leeds Sourdough');
      break;
    case 'studio':
      wordmark(ctx, w, h, p, 'PostMind');
      break;
  }
  // grain
  ctx.fillStyle = 'rgba(0,0,0,0.035)';
  for (let i = 0; i < 180; i++) {
    ctx.fillRect(((i * 97) % w) + ((t * 13) % 3), (i * 53) % h, 1.5, 1.5);
  }
  sampleMark(ctx, w, h);
}

function sampleMark(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const m = Math.min(w, h);
  ctx.font = `600 ${Math.max(10, Math.round(m * 0.035))}px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 4;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText('SAMPLE', w - m * 0.03, h - m * 0.02);
  ctx.shadowBlur = 0;
}

const imageCache = new Map<string, string>();

export function sceneImage(kind: SceneKind, w = 640, h = 640): string {
  const key = `${kind}:${w}x${h}`;
  const hit = imageCache.get(key);
  if (hit) return hit;
  if (kind === 'logo') {
    const svg = logoSvg(w, h);
    imageCache.set(key, svg);
    return svg;
  }
  try {
    const [canvas, ctx] = ctx2d(w, h);
    paintScene(ctx, kind, w, h);
    const url = canvas.toDataURL('image/jpeg', 0.82);
    // Only a photo-backed (or photo-less) drawing is final; a drawing made while the photo was
    // still decoding is redrawn next time.
    if (!SCENE_PHOTOS[kind] || scenePhoto(kind)) imageCache.set(key, url);
    return url;
  } catch {
    return '';
  }
}

export type Aspect = '9:16' | '16:9' | '1:1' | '4:5';

const SIZE: Record<Aspect, [number, number]> = {
  '9:16': [270, 480],
  '16:9': [480, 270],
  '1:1': [360, 360],
  '4:5': [320, 400],
};

export interface VideoSpec {
  scene: SceneKind;
  aspect?: Aspect;
  seconds?: number;
  caption?: string;
}

const videoCache = new Map<string, Promise<string>>();

function supportsRecording(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    'captureStream' in HTMLCanvasElement.prototype
  );
}

function pickMime(): string | undefined {
  const options = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  return options.find((m) => MediaRecorder.isTypeSupported?.(m));
}

function record(spec: VideoSpec): Promise<string> {
  const aspect = spec.aspect ?? '9:16';
  const [w, h] = SIZE[aspect];
  const seconds = spec.seconds ?? 4;
  return new Promise((resolve) => {
    try {
      const [canvas, ctx] = ctx2d(w, h);
      const stream = canvas.captureStream(24);
      const mimeType = pickMime();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        resolve(URL.createObjectURL(new Blob(chunks, { type: mimeType ?? 'video/webm' })));
      };
      const words = (spec.caption ?? '').split(/\s+/).filter(Boolean);
      const started = performance.now();
      const draw = () => {
        const t = (performance.now() - started) / 1000;
        paintScene(ctx, spec.scene, w, h, t);
        if (words.length) {
          const shown = words.slice(
            0,
            Math.min(words.length, Math.floor((t / seconds) * words.length * 1.6) + 1),
          );
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = `800 ${Math.round(Math.min(w, h) * 0.075)}px Inter, system-ui, sans-serif`;
          const line = shown.join(' ');
          const tw = ctx.measureText(line).width;
          ctx.fillStyle = 'rgba(20,16,12,0.72)';
          ctx.fillRect(w / 2 - tw / 2 - 10, h * 0.16 - 18, tw + 20, 36);
          ctx.fillStyle = '#fff';
          ctx.fillText(line, w / 2, h * 0.16);
        }
        ctx.fillStyle = '#e2552f';
        ctx.fillRect(0, h - 4, (w * Math.min(t, seconds)) / seconds, 4);
      };
      draw();
      recorder.start(250);
      const timer = window.setInterval(draw, 1000 / 24);
      window.setTimeout(() => {
        window.clearInterval(timer);
        recorder.stop();
      }, seconds * 1000);
    } catch {
      resolve('');
    }
  });
}

/** A recorded sample clip (blob: URL), or '' where the browser can't record canvas video. */
export function sampleVideo(spec: VideoSpec): Promise<string> {
  if (typeof window === 'undefined' || !supportsRecording()) return Promise.resolve('');
  const key = JSON.stringify(spec);
  let pending = videoCache.get(key);
  if (!pending) {
    pending = record(spec);
    videoCache.set(key, pending);
  }
  return pending;
}
