import type { VisualTreatment } from '@prisma/client';
import type { AspectRatio } from '../providers/interface';

// Layer 6 — Shotstack edit decision list (spec 5.7). Built only from fields in the Shotstack
// Edit API reference (read 2026-09-27): timeline.tracks[].clips[] with asset/start/length/fit/
// transition/effect/position, asset types video/image/audio/html, and output
// format/resolution/aspectRatio/fps. Text cards and captions use the `html` asset (documented,
// flagged deprecated in favour of rich-text); the overlay engine (BACKLOG 8.3) replaces them.
// Shotstack renders tracks top-down: the first track is the top layer.

export const OUTPUT_FPS = 30;
export const OUTPUT_RESOLUTION = '1080';
const VOICE_VOLUME = 1;
const MUSIC_VOLUME = 0.2; // sits under narration (spec 5.6: composition ducks music)
const CAPTION_HEIGHT_RATIO = 0.18;

/** Pixel size of a "1080" render per aspect ratio (Shotstack scales the short side to 1080). */
export function outputDimensions(aspectRatio: AspectRatio): { width: number; height: number } {
  switch (aspectRatio) {
    case '9:16':
      return { width: 1080, height: 1920 };
    case '16:9':
      return { width: 1920, height: 1080 };
    case '1:1':
      return { width: 1080, height: 1080 };
    case '4:5':
      return { width: 1080, height: 1350 };
  }
}

const TRANSITION_MAP: Record<string, string | undefined> = {
  cut: undefined,
  fade: 'fade',
  wipe: 'wipeLeft',
  slide: 'slideLeft',
  zoom: 'zoom',
};

export interface EdlShot {
  durationSec: number;
  visualTreatment: VisualTreatment;
  /** Signed URL of the generated clip or image. Absent for TEXT_CARD. */
  visualSrc?: string;
  visualKind?: 'video' | 'image';
  voiceSrc?: string;
  onScreenText?: string | null;
  transitionOut?: string | null;
  /** For TEXT_CARD shots: the card text (falls back to onScreenText). */
  cardText?: string | null;
}

export interface EdlInput {
  aspectRatio: AspectRatio;
  shots: EdlShot[];
  musicSrc?: string;
  brand?: { backgroundColour?: string; textColour?: string; fontFamily?: string };
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;
const SAFE_FONT = /^[A-Za-z0-9 -]{1,64}$/;

function style(input: EdlInput, fontPx: number, background = 'transparent'): string {
  const colour =
    input.brand?.textColour && HEX_COLOUR.test(input.brand.textColour)
      ? input.brand.textColour
      : '#ffffff';
  const font =
    input.brand?.fontFamily && SAFE_FONT.test(input.brand.fontFamily)
      ? input.brand.fontFamily
      : 'Arial';
  return `p { font-family: '${font}', sans-serif; color: ${colour}; font-size: ${fontPx}px; font-weight: 700; text-align: center; margin: 0; background: ${background}; }`;
}

export function roundSec(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function totalDuration(shots: EdlShot[]): number {
  return roundSec(shots.reduce((sum, s) => sum + s.durationSec, 0));
}

export function buildShotstackEdit(input: EdlInput): Record<string, unknown> {
  const { width, height } = outputDimensions(input.aspectRatio);
  const background =
    input.brand?.backgroundColour && HEX_COLOUR.test(input.brand.backgroundColour)
      ? input.brand.backgroundColour
      : '#000000';
  const visual: Record<string, unknown>[] = [];
  const captions: Record<string, unknown>[] = [];
  const voice: Record<string, unknown>[] = [];

  let start = 0;
  for (const shot of input.shots) {
    const length = roundSec(shot.durationSec);
    const out = TRANSITION_MAP[shot.transitionOut ?? 'cut'];
    const transition = out ? { transition: { out } } : {};

    if (shot.visualTreatment === 'TEXT_CARD' || !shot.visualSrc) {
      const text = shot.cardText ?? shot.onScreenText ?? '';
      visual.push({
        asset: {
          type: 'html',
          html: `<p>${escapeHtml(text)}</p>`,
          css: style(input, Math.round(height * 0.05)),
          width,
          height,
          background,
          position: 'center',
        },
        start: roundSec(start),
        length,
        ...transition,
      });
    } else if (shot.visualKind === 'image') {
      visual.push({
        asset: { type: 'image', src: shot.visualSrc },
        start: roundSec(start),
        length,
        fit: 'cover',
        effect: 'zoomIn', // gentle Ken Burns on stills
        ...transition,
      });
    } else {
      visual.push({
        asset: { type: 'video', src: shot.visualSrc, volume: 0 }, // narration + music carry audio
        start: roundSec(start),
        length,
        fit: 'cover',
        ...transition,
      });
    }

    if (shot.onScreenText && shot.visualTreatment !== 'TEXT_CARD') {
      captions.push({
        asset: {
          type: 'html',
          html: `<p>${escapeHtml(shot.onScreenText)}</p>`,
          css: style(input, Math.round(height * 0.035), 'rgba(0,0,0,0.45)'),
          width: Math.round(width * 0.9),
          height: Math.round(height * CAPTION_HEIGHT_RATIO),
          position: 'bottom',
        },
        start: roundSec(start),
        length,
        position: 'bottom',
      });
    }

    if (shot.voiceSrc) {
      voice.push({
        asset: { type: 'audio', src: shot.voiceSrc, volume: VOICE_VOLUME },
        start: roundSec(start),
        length,
      });
    }
    start += shot.durationSec;
  }

  const tracks: Array<{ clips: Record<string, unknown>[] }> = [];
  if (captions.length) tracks.push({ clips: captions });
  tracks.push({ clips: visual });
  if (voice.length) tracks.push({ clips: voice });
  if (input.musicSrc) {
    tracks.push({
      clips: [
        {
          asset: { type: 'audio', src: input.musicSrc, volume: MUSIC_VOLUME },
          start: 0,
          length: roundSec(start),
        },
      ],
    });
  }

  return {
    timeline: { background, tracks },
    output: {
      format: 'mp4',
      resolution: OUTPUT_RESOLUTION,
      aspectRatio: input.aspectRatio,
      fps: OUTPUT_FPS,
    },
  };
}
