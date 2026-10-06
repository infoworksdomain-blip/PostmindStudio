import type { SlideType } from '@prisma/client';
import {
  escapeHtml,
  MUSIC_ALONE_VOLUME,
  musicClips,
  OUTPUT_FPS,
  OUTPUT_RESOLUTION,
  outputDimensions,
  roundSec,
} from '../pipeline/edl';
import { backdropColour, readableTextColour } from '../pipeline/edl-backdrop';
import type { AspectRatio } from '../providers/interface';
import type { SlideContent } from './planner';

// BACKLOG 7.6 — slideshow composition as a Shotstack edit (same documented subset as
// pipeline/edl.ts: image/video/html/audio assets, clip effect + transition). Ken Burns uses the
// documented clip `effect` values; BEFORE_AFTER is the before image, then the after image
// revealed with a wipe, each labelled. Text is rendered with html assets until the overlay
// engine (BACKLOG 8.3) replaces them.
//
// BACKLOG 20.26 (production, 2026-10-03): slideshows of plain text cards failed black_frames on
// every 16:9 and 1:1 output (the whole video) while the 9:16 one passed. Two causes, both here:
//   1. Backdrop. A card with no colour of its own (slide.backgroundColor NULL) and no brand
//      background was drawn on #000000, and so was the timeline. Cards, image-less slides and the
//      timeline now use the 20.22 backdrop rule (pipeline/edl-backdrop.ts): the brand background
//      when its luma is ≥ 0.2, else the same hue lifted, else slate #3A4150. A colour the user
//      picked for a slide is still drawn as chosen. Shotstack Edit API
//      (https://shotstack.io/docs/api/, read 2026-10-03): Timeline `background` "Defaults to
//      #000000 (black)"; HtmlAsset `background` is the colour "behind the HTML bounding box".
//   2. Text size. Font sizes were a fraction of the frame HEIGHT, so landscape and square frames
//      (1080 px high) drew text at 56 % of the portrait size (1920 px high). ffmpeg blackdetect
//      counts a frame as black when 98 % of its pixels are (pic_th 0.98, media-probe.ts), so white
//      text on a black card covered < 2 % of a 16:9 frame (black) but > 2 % of a 9:16 frame (not
//      black). Text is now sized from the short side (`textBase`, identical on every aspect at
//      1080p), and boxes that hold text are at least as tall as their text. HtmlAsset `width` /
//      `height` are the bounding box in pixels: "Text will wrap to fill the bounding box" and
//      "Text and elements will be masked if they exceed the height of the bounding box";
//      `position` places the HTML "in one of nine predefined positions within the HTML area".
// Images use `fit: 'crop'` (Shotstack's default: "scale the asset to fill the viewport while
// maintaining the aspect ratio"); `cover` "stretch[es] the asset … without maintaining the aspect
// ratio", which squashed landscape stock photos into portrait frames.

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
  /** 13.4: the slide has styled overlays, which replace an image slide's plain caption band. */
  hasOverlays?: boolean;
}

export interface SlideshowEdlInput {
  aspectRatio: AspectRatio;
  slides: ResolvedSlide[];
  musicSrc?: string;
  /** Length of the music file; a shorter track is looped (pipeline/edl.ts musicClips). */
  musicDurationSec?: number;
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
/** Text over images sits on a dark shade, so it stays white (or the brand colour). */
const OVERLAY_TEXT = '#ffffff';
/**
 * 22.4: the shade over a headline slide's photo: the HtmlAsset `background`, 50 % black.
 * Shotstack's HtmlAsset background takes hex with the alpha FIRST ("#80ffffff", opposite to
 * HTML; Edit API reference, HtmlAsset.background, read 2026-10-06).
 */
export const HEADLINE_DIM = '#80000000';
/**
 * Line height used to size text boxes only. 21.7 (production 2026-10-05): the CSS must NOT set
 * it — a unitless `line-height` made Shotstack draw every wrapped line on one baseline. The
 * renderer's default spacing is ≤ this, so boxes sized with it still hold their lines.
 */
const LINE_HEIGHT = 1.25;

/** Font sizes (fractions of `textBase`), as the 9:16 layout has always drawn them. */
export const SLIDE_TEXT = {
  card: 0.05,
  caption: 0.035,
  quote: 0.04,
  statistic: 0.09,
  label: 0.04,
  price: 0.04,
} as const;

/**
 * The pixel size text is scaled from: the frame's long side when it is portrait, i.e. 16/9 of
 * the short side. It is the same on every aspect at one resolution (1920 at 1080p), so a 16:9 or
 * 1:1 output draws text exactly as large as the 9:16 one.
 */
export function textBase(frame: { width: number; height: number }): number {
  return Math.round((Math.min(frame.width, frame.height) * 16) / 9);
}

function css(input: SlideshowEdlInput, px: number, colour: string, extra = ''): string {
  const font =
    input.brand?.fontFamily && SAFE_FONT.test(input.brand.fontFamily)
      ? input.brand.fontFamily
      : 'Arial';
  return `p { font-family: '${font}', sans-serif; color: ${colour}; font-size: ${px}px; font-weight: 700; text-align: center; margin: 0; ${extra} } small { display: block; font-size: 0.55em; font-weight: 400; margin-top: 0.4em; }`;
}

interface Box {
  width: number;
  height: number;
  position: string;
  background?: string;
}

function html(
  input: SlideshowEdlInput,
  body: string,
  px: number,
  box: Box,
  colour: string,
  extra = '',
) {
  return {
    type: 'html',
    html: `<p>${body}</p>`,
    css: css(input, px, colour, extra),
    width: box.width,
    height: box.height,
    ...(box.background && { background: box.background }),
    position: box.position,
  };
}

export function slideshowDuration(slides: ResolvedSlide[]): number {
  return roundSec(slides.reduce((sum, s) => sum + s.durationSec, 0));
}

/** The fill of a slide drawn without an image: the user's colour, else the brand backdrop. */
export function slideBackdrop(slide: Pick<ResolvedSlide, 'backgroundColor'>, backdrop: string) {
  return slide.backgroundColor && HEX.test(slide.backgroundColor)
    ? slide.backgroundColor
    : backdrop;
}

export function buildSlideshowEdit(input: SlideshowEdlInput): Record<string, unknown> {
  const { width, height } = outputDimensions(input.aspectRatio);
  const base = textBase({ width, height });
  const backdrop = backdropColour(input.brand?.backgroundColour);
  const overlayText =
    input.brand?.textColour && HEX.test(input.brand.textColour)
      ? input.brand.textColour
      : OVERLAY_TEXT;
  const visual: Record<string, unknown>[] = [];
  const text: Record<string, unknown>[] = [];
  const full = { width, height, position: 'center' };
  const px = (ratio: number) => Math.round(base * ratio);
  /** A box tall enough for `lines` lines of `size` px text (+ the shade's padding). */
  const fit = (fraction: number, size: number, lines: number) =>
    Math.min(
      height,
      Math.max(Math.round(height * fraction), Math.ceil(size * LINE_HEIGHT * lines * 1.3)),
    );
  const band: Box = {
    width: Math.round(width * 0.9),
    height: fit(0.2, px(SLIDE_TEXT.caption), 2),
    position: 'bottom',
  };
  const label: Box = {
    width: Math.round(width * 0.5),
    height: fit(0.08, px(SLIDE_TEXT.label), 1),
    position: 'top',
  };
  const shade = 'background: rgba(0,0,0,0.45); padding: 0.3em;';
  /** 22.4: full-frame dimming layers under headline text (their own track, above the photos). */
  const dims: Record<string, unknown>[] = [];

  /**
   * 22.4: a hook / closing slide as large centred text over its photo, dimmed (Fastlane's
   * look, operator brief 2026-10-06: the flat grey hook/CTA card looked poster-like). No photo →
   * the ordinary text card on the backdrop.
   */
  const headlineSlide = (
    slide: ResolvedSlide,
    at: number,
    length: number,
    transition: Record<string, unknown>,
  ) => {
    const body = escapeHtml(slide.content.text ?? slide.content.caption ?? '');
    if (!slide.imageSrc) {
      visual.push({
        asset: html(
          input,
          body,
          px(SLIDE_TEXT.card),
          { ...full, background: slideBackdrop(slide, backdrop) },
          readableTextColour(slideBackdrop(slide, backdrop), input.brand?.textColour),
        ),
        start: at,
        length,
        ...transition,
      });
      return;
    }
    visual.push({
      asset: { type: 'image', src: slide.imageSrc },
      start: at,
      length,
      fit: 'crop',
      ...transition,
      ...(slide.slideType === 'IMAGE_KENBURNS' && { effect: slide.kenBurnsEffect ?? 'zoomIn' }),
    });
    dims.push({
      asset: {
        type: 'html',
        html: '<p></p>',
        css: 'p { margin: 0; }',
        width,
        height,
        background: HEADLINE_DIM,
      },
      start: at,
      length,
      position: 'center',
    });
    const size = px(SLIDE_TEXT.card);
    text.push({
      asset: html(
        input,
        body,
        size,
        { width: Math.round(width * 0.86), height: fit(0.5, size, 4), position: 'center' },
        OVERLAY_TEXT,
      ),
      start: at,
      length,
      position: 'center',
    });
  };

  let start = 0;
  for (const slide of input.slides) {
    const length = roundSec(slide.durationSec);
    const at = roundSec(start);
    const transitionName = TRANSITION_IN[slide.transitionIn ?? 'cut'];
    const transition = transitionName ? { transition: { in: transitionName } } : {};
    const c = slide.content;
    const fill = slideBackdrop(slide, backdrop);
    const image = (src: string, s: number, l: number, extra: Record<string, unknown> = {}) =>
      visual.push({
        asset: { type: 'image', src },
        start: roundSec(s),
        length: roundSec(l),
        fit: 'crop',
        ...extra,
      });
    const card = (body: string, size: number, s = start, l = slide.durationSec, t = transition) =>
      visual.push({
        asset: html(
          input,
          body,
          size,
          { ...full, background: fill },
          readableTextColour(fill, input.brand?.textColour),
        ),
        start: roundSec(s),
        length: roundSec(l),
        ...t,
      });
    const overlay = (body: string, size: number, box = band, extra = shade) =>
      text.push({
        asset: html(input, body, size, box, overlayText, extra),
        start: at,
        length,
        position: box.position,
      });

    switch (slide.slideType) {
      case 'TEXT_CARD':
        card(escapeHtml(c.text ?? ''), px(SLIDE_TEXT.card));
        break;
      case 'VIDEO_CLIP':
        if (!slide.videoSrc) {
          card('', 10);
          break;
        }
        visual.push({
          asset: { type: 'video', src: slide.videoSrc, volume: 0 },
          start: at,
          length,
          fit: 'crop',
          ...transition,
        });
        break;
      case 'BEFORE_AFTER': {
        const half = length / 2;
        const wipe = { transition: { in: 'wipeLeft' } };
        if (slide.beforeSrc) image(slide.beforeSrc, start, half, transition);
        else card('', 10, start, half);
        if (slide.afterSrc) image(slide.afterSrc, start + half, length - half, wipe);
        else card('', 10, start + half, length - half, wipe);
        text.push(
          {
            asset: html(input, 'BEFORE', px(SLIDE_TEXT.label), label, overlayText, shade),
            start: at,
            length: roundSec(half),
            position: 'top',
          },
          {
            asset: html(input, 'AFTER', px(SLIDE_TEXT.label), label, overlayText, shade),
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
        else card('', 10);
        const body =
          slide.slideType === 'QUOTE'
            ? `“${escapeHtml(c.quote ?? '')}”${c.author ? `<small>— ${escapeHtml(c.author)}</small>` : ''}`
            : `${escapeHtml(c.value ?? '')}<small>${escapeHtml(c.label ?? '')}</small>`;
        overlay(body, px(slide.slideType === 'QUOTE' ? SLIDE_TEXT.quote : SLIDE_TEXT.statistic), {
          width: Math.round(width * 0.85),
          height: Math.round(height * 0.5),
          position: 'center',
        });
        break;
      }
      case 'PRODUCT': {
        if (slide.imageSrc) image(slide.imageSrc, start, length, transition);
        else card('', 10);
        const features = (c.features ?? [])
          .map((f) => `<small>✓ ${escapeHtml(f)}</small>`)
          .join('');
        overlay(`${escapeHtml(c.name ?? '')}${features}`, px(SLIDE_TEXT.caption));
        if (c.price) {
          overlay(escapeHtml(c.price), px(SLIDE_TEXT.price), {
            width: Math.round(width * 0.35),
            height: fit(0.08, px(SLIDE_TEXT.price), 1),
            position: 'topRight',
          });
        }
        break;
      }
      case 'IMAGE_STILL':
      case 'IMAGE_KENBURNS': {
        if (c.headline && !slide.hasOverlays) {
          headlineSlide(slide, at, length, transition);
          break;
        }
        if (slide.imageSrc) {
          image(slide.imageSrc, start, length, {
            ...transition,
            ...(slide.slideType === 'IMAGE_KENBURNS' && {
              effect: slide.kenBurnsEffect ?? 'zoomIn',
            }),
          });
        } else {
          // 20.26: never an empty (black) frame; the caption still shows over the backdrop.
          card('', 10);
        }
        const caption = [c.number ? `${c.number}.` : null, c.name, c.text]
          .filter(Boolean)
          .join(' ');
        const shown = c.caption ?? (caption || null);
        if (shown && !slide.hasOverlays) overlay(escapeHtml(shown), px(SLIDE_TEXT.caption));
        break;
      }
    }
    start += slide.durationSec;
  }

  const tracks: Array<{ clips: Record<string, unknown>[] }> = [];
  if (text.length) tracks.push({ clips: text });
  if (dims.length) tracks.push({ clips: dims });
  tracks.push({ clips: visual });
  if (input.musicSrc) {
    // Slideshows have no narration, so the music is the only audio.
    tracks.push({
      clips: musicClips({
        src: input.musicSrc,
        trackSec: input.musicDurationSec,
        videoSec: roundSec(start),
        volume: MUSIC_ALONE_VOLUME,
      }),
    });
  }
  return {
    // 20.26: fades and gaps show the backdrop, never Shotstack's default black.
    timeline: { background: backdrop, tracks },
    output: {
      format: 'mp4',
      resolution: OUTPUT_RESOLUTION,
      aspectRatio: input.aspectRatio,
      fps: OUTPUT_FPS,
    },
  };
}
