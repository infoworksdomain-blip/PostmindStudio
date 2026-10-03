import type { VisualTreatment } from '@prisma/client';
import type { AspectRatio } from '../providers/interface';
import {
  brandImageRect,
  cardClip,
  cardSec,
  logoClip,
  watermarkClip,
  WATERMARK_OPACITY,
  WATERMARK_SCALE,
  type BrandMedia,
} from './edl-brand';
import { duckedMusicClips, type MusicSpan } from './edl-music';
import { escapeHtml, HEX_COLOUR, roundSec, SAFE_FONT } from './edl-time';
import { backdropColour, readableTextColour } from './edl-backdrop';
import type { CompositionSummary } from './composition-summary';
import { aiLabelClip } from './ai-label';
import { fontFamilyFor, isRtl, scriptOf } from '../i18n/scripts';
import { motionCardClips, motionPalette } from './motion-graphics';
import {
  outputDimensions as presetDimensions,
  presetOutput,
  type RenderPreset,
} from './render-presets';

export { escapeHtml, roundSec } from './edl-time';

// Layer 6 — Shotstack edit decision list (spec 5.7). Built only from fields in the Shotstack
// Edit API reference (read 2026-09-27): timeline.tracks[].clips[] with asset/start/length/fit/
// transition/effect/position, asset types video/image/audio/html/shape, timeline.fonts, and
// output format/resolution/aspectRatio/fps (+ scaleTo/quality for presets, render-presets.ts).
// Text cards and captions use the `html` asset (documented, flagged deprecated in favour of
// rich-text); the overlay engine (BACKLOG 8.3) replaces them.
// Shotstack renders tracks top-down: the first track is the top layer.
// Phase 15: brand logo/watermark/intro/outro (15.B1, edl-brand.ts), narration clipped at a word
// boundary (15.B3), per-shot music ducking (15.B4, edl-music.ts), render presets (15.B7) and
// composer-rendered MOTION_GRAPHICS cards (15.B8, motion-graphics.ts).

export const OUTPUT_FPS = 30;
export const OUTPUT_RESOLUTION = '1080';
const VOICE_VOLUME = 1;
// Music bed levels (spec 5.6 "composition ducks music"). Shotstack AudioAsset `volume` is 0–1
// and `effect` is fadeIn | fadeOut | fadeInFadeOut; a clip plays "until the file ends or the
// Clip length is reached" (https://shotstack.io/docs/api/#tocs_audioasset, read 2026-09-27).
// 0.2 ≈ −14 dB under narration; 0.7 ≈ −3 dB when music is the only audio (slideshows),
// keeping the mix inside the quality gate's −18…−10 LUFS window (quality-checks.ts).
export const MUSIC_UNDER_VOICE_VOLUME = 0.2;
export const MUSIC_ALONE_VOLUME = 0.7;
const CAPTION_HEIGHT_RATIO = 0.18;
/**
 * Ken Burns on stills (Shotstack clip `effect`; the slideshow planner uses the same names). 20.25:
 * stills alternate a slow push in and pull out so a video with several image shots does not repeat
 * one move. Both start or end at full size over a `cover` fit, so the frame is always filled (no
 * letterbox bars for blackdetect); slides are not used here because they move the frame.
 */
export const STILL_EFFECTS = ['zoomIn', 'zoomOut'] as const;

/** Pixel size of the layout per aspect ratio (short side 1080; 2160 for 4K presets). */
export const outputDimensions = presetDimensions;

const TRANSITION_MAP: Record<string, string | undefined> = {
  cut: undefined,
  fade: 'fade',
  wipe: 'wipeLeft',
  slide: 'slideLeft',
  zoom: 'zoom',
};

export interface EdlShot {
  /** video_shots.id, recorded in the composition summary (quality checks). */
  id?: string;
  durationSec: number;
  visualTreatment: VisualTreatment;
  /** Signed URL of the generated clip or image. Absent for TEXT_CARD. */
  visualSrc?: string;
  visualKind?: 'video' | 'image';
  voiceSrc?: string;
  /** 15.B3: narration trimmed at a word boundary: the voice clip stops here (≤ the shot). */
  voiceTrimSec?: number | null;
  /** 13.5: play the clip's own audio (uploaded videos); otherwise the clip is muted. */
  keepSourceAudio?: boolean;
  onScreenText?: string | null;
  transitionOut?: string | null;
  /** For TEXT_CARD shots: the card text (falls back to onScreenText). */
  cardText?: string | null;
  /** 13.27: signed URL of the shot's sound effect, played from the shot's start (the cut in). */
  sfxSrc?: string;
  /** Length of the SFX file, when known; the clip is capped at SFX_MAX_SEC and the shot. */
  sfxDurationSec?: number | null;
}

/** 13.27 SFX level under narration (Shotstack AudioAsset volume 0–1; ≈ −6 dB). */
export const SFX_VOLUME = 0.5;
/** Longest effect laid on the timeline (pipeline/sfx.ts asks Storyblocks for ≤ 3 s clips). */
export const SFX_MAX_SEC = 3;

/** Level of an uploaded clip's own soundtrack (Shotstack VideoAsset volume 0–1). */
export const SOURCE_AUDIO_VOLUME = 1;

export interface EdlInput {
  aspectRatio: AspectRatio;
  shots: EdlShot[];
  musicSrc?: string;
  /** Length of the music file; a shorter track is looped to cover the video. */
  musicDurationSec?: number;
  brand?: {
    backgroundColour?: string;
    textColour?: string;
    fontFamily?: string;
    /** Brand palette (motion-graphics cards use colours 1–3). */
    palette?: string[];
    /** timeline.fonts sources for the brand font (uploaded TTF or the fonts host). */
    fontSources?: string[];
  };
  /** 15.B1 brand-kit media. */
  brandMedia?: BrandMedia;
  /** 15.B7 render preset; absent = the legacy 1080p/30fps output. */
  preset?: RenderPreset;
  /** Script language (15.C5): picks the font per writing system and RTL direction. */
  language?: string | null;
  /** P6: the brand kit's on-video "AI-generated" label. */
  aiLabel?: boolean;
  /** P2: a platform end card for non-white-label outputs (never set for white-label). */
  platformCard?: BrandMedia['outro'];
}

function brandColours(input: EdlInput) {
  const background =
    input.brand?.backgroundColour && HEX_COLOUR.test(input.brand.backgroundColour)
      ? input.brand.backgroundColour
      : '#000000';
  const text =
    input.brand?.textColour && HEX_COLOUR.test(input.brand.textColour)
      ? input.brand.textColour
      : '#ffffff';
  // Latin text uses the brand font; Arabic, Devanagari and Han use the script's Noto family
  // (a Latin brand font has no glyphs for them; i18n/scripts.ts).
  const script = scriptOf(input.language);
  const brandFont =
    input.brand?.fontFamily && SAFE_FONT.test(input.brand.fontFamily)
      ? input.brand.fontFamily
      : 'Arial';
  const font = script === 'latin' ? brandFont : fontFamilyFor(script, 700);
  // 20.22: cards and the timeline sit on a non-black backdrop (edl-backdrop.ts); the brand's own
  // colours are still what the summary records for the brand_kit check.
  const backdrop = backdropColour(input.brand?.backgroundColour);
  const cardText = readableTextColour(backdrop, input.brand?.textColour);
  return { background, text, font, rtl: isRtl(input.language), backdrop, cardText };
}

/** `<p>` with `dir="rtl"` for right-to-left languages (HTML's own bidi attribute). */
function para(input: EdlInput, text: string): string {
  return `<p${isRtl(input.language) ? ' dir="rtl"' : ''}>${escapeHtml(text)}</p>`;
}

function style(
  input: EdlInput,
  fontPx: number,
  background = 'transparent',
  colour = brandColours(input).text,
): string {
  const { font } = brandColours(input);
  return `p { font-family: '${font}', sans-serif; color: ${colour}; font-size: ${fontPx}px; font-weight: 700; text-align: center; margin: 0; background: ${background}; }`;
}

export function totalDuration(shots: EdlShot[]): number {
  return roundSec(shots.reduce((sum, s) => sum + s.durationSec, 0));
}

/** Total length of the edit, including brand intro/outro cards. */
export function editDuration(shots: EdlShot[], media?: BrandMedia): number {
  return roundSec(totalDuration(shots) + cardSec(media?.intro) + cardSec(media?.outro));
}

/**
 * The music track's clips: one clip trimmed to the video when the track is long enough,
 * otherwise the track repeated back to back (ElevenLabs Music is capped at 5 minutes). The
 * last clip fades out, so the video never ends on a hard cut of the music.
 */
export function musicClips(input: {
  src: string;
  trackSec?: number;
  videoSec: number;
  volume: number;
}): Record<string, unknown>[] {
  return duckedMusicClips({
    src: input.src,
    trackSec: input.trackSec,
    spans: [{ startSec: 0, endSec: input.videoSec, volume: input.volume }],
  });
}

interface Tracks {
  visual: Record<string, unknown>[];
  motionAccent: Record<string, unknown>[];
  motionText: Record<string, unknown>[];
  captions: Record<string, unknown>[];
  voice: Record<string, unknown>[];
  sfx: Record<string, unknown>[];
}

function visualClip(
  input: EdlInput,
  shot: EdlShot,
  at: number,
  frame: { width: number; height: number },
  tracks: Tracks,
  /** How many image shots came before this one (picks the Ken Burns move). */
  stillIndex: number,
): void {
  const length = roundSec(shot.durationSec);
  const out = TRANSITION_MAP[shot.transitionOut ?? 'cut'];
  const transition = out ? { transition: { out } } : {};
  const start = roundSec(at);
  const colours = brandColours(input);

  if (shot.visualTreatment === 'MOTION_GRAPHICS') {
    const clips = motionCardClips({
      startSec: at,
      lengthSec: shot.durationSec,
      text: shot.cardText ?? shot.onScreenText ?? '',
      frame,
      palette: motionPalette(input.brand?.palette ?? []),
      fontFamily: colours.font,
      rtl: colours.rtl,
      transitionOut: out,
    });
    tracks.visual.push(clips.background);
    tracks.motionAccent.push(clips.accent);
    tracks.motionText.push(clips.text);
  } else if (shot.visualTreatment === 'TEXT_CARD' || !shot.visualSrc) {
    const text = shot.cardText ?? shot.onScreenText ?? '';
    tracks.visual.push({
      asset: {
        type: 'html',
        html: para(input, text),
        css: style(input, Math.round(frame.height * 0.05), 'transparent', colours.cardText),
        width: frame.width,
        height: frame.height,
        // 20.22: a designed, non-black fill for the whole frame (HtmlAsset `background`).
        background: colours.backdrop,
        position: 'center',
      },
      start,
      length,
      ...transition,
    });
  } else if (shot.visualKind === 'image') {
    tracks.visual.push({
      asset: { type: 'image', src: shot.visualSrc },
      start,
      length,
      fit: 'cover',
      effect: STILL_EFFECTS[stillIndex % STILL_EFFECTS.length], // gentle Ken Burns on stills
      ...transition,
    });
  } else {
    tracks.visual.push({
      // Narration + music carry the audio, except for an uploaded clip's own soundtrack.
      asset: {
        type: 'video',
        src: shot.visualSrc,
        volume: shot.keepSourceAudio ? SOURCE_AUDIO_VOLUME : 0,
      },
      start,
      length,
      fit: 'cover',
      ...transition,
    });
  }
}

function audioAndCaptions(
  input: EdlInput,
  shot: EdlShot,
  at: number,
  frame: { width: number; height: number },
  tracks: Tracks,
): number | null {
  const length = roundSec(shot.durationSec);
  const start = roundSec(at);
  const hasOwnText =
    shot.visualTreatment === 'TEXT_CARD' || shot.visualTreatment === 'MOTION_GRAPHICS';
  if (shot.onScreenText && !hasOwnText) {
    tracks.captions.push({
      asset: {
        type: 'html',
        html: para(input, shot.onScreenText),
        css: style(input, Math.round(frame.height * 0.035), 'rgba(0,0,0,0.45)'),
        width: Math.round(frame.width * 0.9),
        height: Math.round(frame.height * CAPTION_HEIGHT_RATIO),
        position: 'bottom',
      },
      start,
      length,
      position: 'bottom',
    });
  }
  if (shot.sfxSrc) {
    const sfxLength = Math.min(
      SFX_MAX_SEC,
      shot.durationSec,
      shot.sfxDurationSec && shot.sfxDurationSec > 0 ? shot.sfxDurationSec : SFX_MAX_SEC,
    );
    tracks.sfx.push({
      asset: { type: 'audio', src: shot.sfxSrc, volume: SFX_VOLUME },
      start,
      length: roundSec(sfxLength),
    });
  }
  if (!shot.voiceSrc) return null;
  const clipSec =
    shot.voiceTrimSec && shot.voiceTrimSec > 0
      ? Math.min(length, roundSec(shot.voiceTrimSec))
      : length;
  tracks.voice.push({
    asset: { type: 'audio', src: shot.voiceSrc, volume: VOICE_VOLUME },
    start,
    length: clipSec,
  });
  return clipSec;
}

export interface ShotstackComposition {
  edit: Record<string, unknown>;
  /** What was put on the timeline (without edlHash; compose adds it). */
  summary: CompositionSummary;
}

export function buildShotstackComposition(input: EdlInput): ShotstackComposition {
  const frame = outputDimensions(input.aspectRatio, input.preset?.resolution);
  const colours = brandColours(input);
  const media = input.brandMedia ?? {};
  const tracks: Tracks = {
    visual: [],
    motionAccent: [],
    motionText: [],
    captions: [],
    voice: [],
    sfx: [],
  };
  const introSec = cardSec(media.intro);
  if (media.intro) tracks.visual.push(cardClip(media.intro, 0, 'intro'));

  const summaryShots: CompositionSummary['shots'] = [];
  const spans: MusicSpan[] = [];
  let start = introSec;
  let stills = 0;
  for (const shot of input.shots) {
    const isStill =
      shot.visualKind === 'image' &&
      Boolean(shot.visualSrc) &&
      shot.visualTreatment !== 'TEXT_CARD' &&
      shot.visualTreatment !== 'MOTION_GRAPHICS';
    visualClip(input, shot, start, frame, tracks, stills);
    if (isStill) stills += 1;
    const voiceClipSec = audioAndCaptions(input, shot, start, frame, tracks);
    summaryShots.push({
      shotId: shot.id ?? null,
      startSec: roundSec(start),
      lengthSec: roundSec(shot.durationSec),
      treatment: shot.visualTreatment,
      voiceClipSec,
    });
    spans.push({
      startSec: start,
      endSec: start + shot.durationSec,
      volume: shot.voiceSrc ? 1 : 0,
    });
    start += shot.durationSec;
  }
  const contentEnd = start;
  const outroSec = cardSec(media.outro);
  if (media.outro) tracks.visual.push(cardClip(media.outro, contentEnd, 'outro'));
  const platformSec = cardSec(input.platformCard);
  if (input.platformCard)
    tracks.visual.push(cardClip(input.platformCard, contentEnd + outroSec, 'outro'));
  const totalSec = roundSec(contentEnd + outroSec + platformSec);

  const content = { startSec: introSec, lengthSec: roundSec(contentEnd - introSec) };
  const hasContent = content.lengthSec > 0;
  const logo = media.logo && hasContent ? [logoClip(media.logo, content)] : [];
  const watermark = media.watermark && hasContent ? [watermarkClip(media.watermark, content)] : [];
  const label =
    input.aiLabel && hasContent
      ? [
          aiLabelClip({
            lang: input.language,
            startSec: content.startSec,
            lengthSec: content.lengthSec,
            frame,
            fontFamily: colours.font,
            rtl: colours.rtl,
          }),
        ]
      : [];

  const out: Array<{ clips: Record<string, unknown>[] }> = [];
  for (const clips of [
    tracks.captions,
    tracks.motionText,
    tracks.motionAccent,
    label,
    watermark,
    logo,
    tracks.visual,
    tracks.voice,
    // 13.27: effects sit under the narration and above the music bed.
    tracks.sfx,
  ]) {
    if (clips.length || clips === tracks.visual) out.push({ clips });
  }
  if (input.musicSrc) {
    // 15.B4: duck under narrated shots; full bed where nothing is said (cards, silent shots).
    const narrated = tracks.voice.length > 0;
    const level = (voiced: boolean) =>
      narrated && voiced ? MUSIC_UNDER_VOICE_VOLUME : MUSIC_ALONE_VOLUME;
    const bed: MusicSpan[] = [
      { startSec: 0, endSec: introSec, volume: level(false) },
      ...spans.map((s) => ({ ...s, volume: level(s.volume === 1) })),
      { startSec: contentEnd, endSec: totalSec, volume: level(false) },
    ];
    out.push({
      clips: duckedMusicClips({
        src: input.musicSrc,
        trackSec: input.musicDurationSec,
        spans: bed,
      }),
    });
  }

  const fontSources = [...new Set(input.brand?.fontSources ?? [])];
  const edit: Record<string, unknown> = {
    timeline: {
      // 20.22: what a fade dips to and what shows when a clip ends early; never black.
      background: colours.backdrop,
      ...(fontSources.length && { fonts: fontSources.map((src) => ({ src })) }),
      tracks: out,
    },
    output: input.preset
      ? presetOutput(input.aspectRatio, input.preset)
      : {
          format: 'mp4',
          resolution: OUTPUT_RESOLUTION,
          aspectRatio: input.aspectRatio,
          fps: OUTPUT_FPS,
        },
  };
  const summary: CompositionSummary = {
    version: 1,
    frame,
    totalSec,
    introSec,
    outroSec: roundSec(outroSec + platformSec),
    shots: summaryShots,
    brand: {
      logo: logo.length > 0,
      watermark:
        media.watermark && hasContent
          ? {
              rect: brandImageRect(media.watermark, frame, WATERMARK_SCALE, 'topLeft'),
              opacity: WATERMARK_OPACITY,
              startSec: content.startSec,
              endSec: roundSec(contentEnd),
            }
          : null,
      intro: Boolean(media.intro),
      outro: Boolean(media.outro),
      aiLabel: label.length > 0,
      platformCard: Boolean(input.platformCard),
      fontFamily: colours.font,
      fontSources,
      textColour: colours.text,
      backgroundColour: colours.background,
      backdropColour: colours.backdrop,
    },
  };
  return { edit, summary };
}

export function buildShotstackEdit(input: EdlInput): Record<string, unknown> {
  return buildShotstackComposition(input).edit;
}
