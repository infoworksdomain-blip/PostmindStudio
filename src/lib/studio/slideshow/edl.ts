import type { SlideType } from '@prisma/client';
import {
  escapeHtml,
  OUTPUT_FPS,
  OUTPUT_RESOLUTION,
  outputDimensions,
  roundSec,
} from '../pipeline/edl';
import type { AspectRatio } from '../providers/interface';
import type { SlideContent } from './planner';

// BACKLOG 7.6 — slideshow composition as a Shotstack edit (same documented subset as
// pipeline/edl.ts: image/video/html/audio assets, clip effect + transition). Ken Burns uses the
// documented clip `effect` values; BEFORE_AFTER is the before image, then the after image
// revealed with a wipe, each labelled. Text is rendered with html assets until the overlay
// engine (BACKLOG 8.3) replaces them.

export interface ResolvedSlide {
  slideType: SlideType;
  durationSec: number;
  transitionIn: string | null;
  imageSrc?: string;
  videoSrc?: string;
  beforeSrc?: string;
  afterSrc?: string;
  backgroundColor: string | null;
  kenBurnsEffect?: string;
  content: SlideContent;
}

export interface SlideshowEdlInput {
  aspectRatio: AspectRatio;
  slides: ResolvedSlide[];
  musicSrc?: string;
  brand?: { backgroundColour?: string; textColour?: string; fontFamily?: string };
}

const TRANSITION_IN: Record<string, string | undefined> = {
  cut: undefined,
  fade: 'fade',
  wipe: 'wipeLeft',
  slide: 'slideLeft',
  zoom: 'zoom',
};
const HEX = /^#[0-9a-fA-F]{6}$/;
const SAFE_FONT = /^[A-Za-z0-9 -]{1,64}$/;

function css(input: SlideshowEdlInput, px: number, extra = ''): string {
  const colour =
    input.brand?.textColour && HEX.test(input.brand.textColour)
      ? input.brand.textColour
      : '#ffffff';
  const font =
    input.brand?.fontFamily && SAFE_FONT.test(input.brand.fontFamily)
      ? input.brand.fontFamily
      : 'Arial';
  return `p { font-family: '${font}', sans-serif; color: ${colour}; font-size: ${px}px; font-weight: 700; text-align: center; margin: 0; ${extra} } small { display: block; font-size: 0.55em; font-weight: 400; margin-top: 0.4em; }`;
}

function html(
  input: SlideshowEdlInput,
  body: string,
  px: number,
  box: { width: number; height: number; position: string; background?: string },
  extra = '',
) {
  return {
    type: 'html',
    html: `<p>${body}</p>`,
    css: css(input, px, extra),
    width: box.width,
    height: box.height,
    ...(box.background && { background: box.background }),
    position: box.position,
  };
}

export function slideshowDuration(slides: ResolvedSlide[]): number {
  return roundSec(slides.reduce((sum, s) => sum + s.durationSec, 0));
}

export function buildSlideshowEdit(input: SlideshowEdlInput): Record<string, unknown> {
  const { width, height } = outputDimensions(input.aspectRatio);
  const brandBg =
    input.brand?.backgroundColour && HEX.test(input.brand.backgroundColour)
      ? input.brand.backgroundColour
      : '#000000';
  const visual: Record<string, unknown>[] = [];
  const text: Record<string, unknown>[] = [];
  const full = { width, height, position: 'center' };
  const band = {
    width: Math.round(width * 0.9),
    height: Math.round(height * 0.2),
    position: 'bottom',
  };
  const shade = 'background: rgba(0,0,0,0.45); padding: 0.3em;';

  let start = 0;
  for (const slide of input.slides) {
    const length = roundSec(slide.durationSec);
    const at = roundSec(start);
    const transitionName = TRANSITION_IN[slide.transitionIn ?? 'cut'];
    const transition = transitionName ? { transition: { in: transitionName } } : {};
    const c = slide.content;
    const image = (src: string, s: number, l: number, extra: Record<string, unknown> = {}) =>
      visual.push({
        asset: { type: 'image', src },
        start: roundSec(s),
        length: roundSec(l),
        fit: 'cover',
        ...extra,
      });
    const card = (body: string, px: number, background: string) =>
      visual.push({
        asset: html(input, body, px, { ...full, background }),
        start: at,
        length,
        ...transition,
      });
    const overlay = (body: string, px: number, box = band, extra = shade) =>
      text.push({
        asset: html(input, body, px, box, extra),
        start: at,
        length,
        position: box.position,
      });

    switch (slide.slideType) {
      case 'TEXT_CARD':
        card(
          escapeHtml(c.text ?? ''),
          Math.round(height * 0.05),
          slide.backgroundColor && HEX.test(slide.backgroundColor)
            ? slide.backgroundColor
            : brandBg,
        );
        break;
      case 'VIDEO_CLIP':
        visual.push({
          asset: { type: 'video', src: slide.videoSrc, volume: 0 },
          start: at,
          length,
          fit: 'cover',
          ...transition,
        });
        break;
      case 'BEFORE_AFTER': {
        const half = length / 2;
        if (slide.beforeSrc) image(slide.beforeSrc, start, half, transition);
        if (slide.afterSrc)
          image(slide.afterSrc, start + half, length - half, { transition: { in: 'wipeLeft' } });
        text.push(
          {
            asset: html(
              input,
              'BEFORE',
              Math.round(height * 0.04),
              {
                width: Math.round(width * 0.5),
                height: Math.round(height * 0.08),
                position: 'top',
              },
              shade,
            ),
            start: at,
            length: roundSec(half),
            position: 'top',
          },
          {
            asset: html(
              input,
              'AFTER',
              Math.round(height * 0.04),
              {
                width: Math.round(width * 0.5),
                height: Math.round(height * 0.08),
                position: 'top',
              },
              shade,
            ),
            start: roundSec(start + half),
            length: roundSec(length - half),
            position: 'top',
          },
        );
        break;
      }
      case 'QUOTE':
      case 'STATISTIC': {
        if (slide.imageSrc) image(slide.imageSrc, start, length, transition);
        else
          card(
            '',
            10,
            slide.backgroundColor && HEX.test(slide.backgroundColor)
              ? slide.backgroundColor
              : brandBg,
          );
        const body =
          slide.slideType === 'QUOTE'
            ? `“${escapeHtml(c.quote ?? '')}”${c.author ? `<small>— ${escapeHtml(c.author)}</small>` : ''}`
            : `${escapeHtml(c.value ?? '')}<small>${escapeHtml(c.label ?? '')}</small>`;
        const px =
          slide.slideType === 'QUOTE' ? Math.round(height * 0.04) : Math.round(height * 0.09);
        overlay(body, px, {
          width: Math.round(width * 0.85),
          height: Math.round(height * 0.5),
          position: 'center',
        });
        break;
      }
      case 'PRODUCT': {
        if (slide.imageSrc) image(slide.imageSrc, start, length, transition);
        const features = (c.features ?? [])
          .map((f) => `<small>✓ ${escapeHtml(f)}</small>`)
          .join('');
        overlay(`${escapeHtml(c.name ?? '')}${features}`, Math.round(height * 0.035));
        if (c.price) {
          overlay(escapeHtml(c.price), Math.round(height * 0.04), {
            width: Math.round(width * 0.35),
            height: Math.round(height * 0.08),
            position: 'topRight',
          });
        }
        break;
      }
      case 'IMAGE_STILL':
      case 'IMAGE_KENBURNS': {
        if (slide.imageSrc) {
          image(slide.imageSrc, start, length, {
            ...transition,
            ...(slide.slideType === 'IMAGE_KENBURNS' && {
              effect: slide.kenBurnsEffect ?? 'zoomIn',
            }),
          });
        }
        const label = [c.number ? `${c.number}.` : null, c.name, c.text].filter(Boolean).join(' ');
        const caption = c.caption ?? (label || null);
        if (caption) overlay(escapeHtml(caption), Math.round(height * 0.035));
        break;
      }
    }
    start += slide.durationSec;
  }

  const tracks: Array<{ clips: Record<string, unknown>[] }> = [];
  if (text.length) tracks.push({ clips: text });
  tracks.push({ clips: visual });
  if (input.musicSrc) {
    tracks.push({
      clips: [
        {
          asset: { type: 'audio', src: input.musicSrc, volume: 1 },
          start: 0,
          length: roundSec(start),
        },
      ],
    });
  }
  return {
    timeline: { background: brandBg, tracks },
    output: {
      format: 'mp4',
      resolution: OUTPUT_RESOLUTION,
      aspectRatio: input.aspectRatio,
      fps: OUTPUT_FPS,
    },
  };
}
