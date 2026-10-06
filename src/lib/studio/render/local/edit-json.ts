import { NotImplementedError } from '../../../errors';

// Small readers for the Shotstack edit JSON the composer builds (pipeline/edl.ts,
// slideshow/edl.ts, overlays/shotstack.ts). The local renderer reads only fields those builders
// write; anything else is reported as not implemented so the render goes to Shotstack instead.

export type Json = Record<string, unknown>;

export function asRecord(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The local renderer does not draw this part of the edit (the caller falls back to Shotstack). */
export function unsupported(what: string): never {
  throw new NotImplementedError(`local renderer: ${what}`, { renderer: 'local-ffmpeg' });
}

/** Colour with straight alpha, channels 0–255, alpha 0–1. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const HEX6 = /^#([0-9a-f]{6})$/i;
const HEX3 = /^#([0-9a-f]{3})$/i;
const HEX8 = /^#([0-9a-f]{8})$/i;
const RGBA = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/i;

function channel(hex: string, at: number): number {
  return Number.parseInt(hex.slice(at, at + 2), 16);
}

/**
 * A colour as the composer writes it. CSS (`#fff`, `#ffffff`, `rgba(0,0,0,0.45)`,
 * `transparent`); Shotstack's 8-digit HtmlAsset background puts the alpha FIRST ("#80000000",
 * slideshow/edl.ts HEADLINE_DIM) — `alphaFirst` reads it that way; overlay colours are
 * #RRGGBBAA (overlays/params.ts), read with alphaFirst false.
 */
export function parseColour(value: string, alphaFirst = false): Rgba | null {
  const v = value.trim();
  if (v.toLowerCase() === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const six = HEX6.exec(v)?.[1];
  if (six) return { r: channel(six, 0), g: channel(six, 2), b: channel(six, 4), a: 1 };
  const three = HEX3.exec(v)?.[1];
  if (three) {
    const [r, g, b] = [...three].map((c) => Number.parseInt(c + c, 16)) as [number, number, number];
    return { r, g, b, a: 1 };
  }
  const eight = HEX8.exec(v)?.[1];
  if (eight) {
    return alphaFirst
      ? {
          a: channel(eight, 0) / 255,
          r: channel(eight, 2),
          g: channel(eight, 4),
          b: channel(eight, 6),
        }
      : {
          r: channel(eight, 0),
          g: channel(eight, 2),
          b: channel(eight, 4),
          a: channel(eight, 6) / 255,
        };
  }
  const m = RGBA.exec(v);
  if (m) {
    const alpha = m[4] === undefined ? 1 : Number(m[4]);
    const clamp = (n: number) => Math.min(255, Math.max(0, n));
    return {
      r: clamp(Number(m[1])),
      g: clamp(Number(m[2])),
      b: clamp(Number(m[3])),
      a: Math.min(1, Math.max(0, alpha)),
    };
  }
  return null;
}

/** #RRGGBB of a colour (alpha dropped). */
export function hexOf(c: Rgba): string {
  return `#${[c.r, c.g, c.b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
}

/** CSS rgba() for SVG fills. */
export function cssOf(c: Rgba): string {
  return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${Math.round(c.a * 1000) / 1000})`;
}

/** ffmpeg colour syntax 0xRRGGBB (ffmpeg-utils "Color"), opaque. */
export function ffmpegColour(c: Rgba): string {
  return `0x${hexOf(c).slice(1).toUpperCase()}`;
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/** Undo pipeline/edl-time.ts escapeHtml (the only entities the composer writes). */
export function unescapeHtml(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e] ?? e);
}
