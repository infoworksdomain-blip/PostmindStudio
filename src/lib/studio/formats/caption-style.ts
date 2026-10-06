import type { Prisma } from '@prisma/client';
import { ValidationError } from '../../errors';
import { ON_SCREEN_KIND } from '../overlays/kind';
import { resolveStyle, type OverlayStyle } from '../overlays/params';
import { BUILT_IN_PRESETS, UGC_CAPTION_PRESET, UGC_HOOK_PRESET } from '../overlays/presets';

// BACKLOG 22.1 / 22.2 (operator request 2026-10-05, Fastlane research) — the "TikTok classic"
// text look both formats use: white Montserrat with a 3 px black stroke, no background box and no
// soft shadow, placed inside the platform safe area. It is built on the existing built-in presets
// (21.4b: `hook_tiktok_classic` for the hook line, `subtitle_tiktok_classic` for the text block)
// with this format's size, weight (600–700) and position; the overlay records the preset, so the
// owner can still edit the text, timing and style on the Review screen like any overlay.
//
// The overlay is rendered as a Shotstack `rich-text` asset (overlays/shotstack.ts): font, stroke
// and line height are rich-text fields, not HTML CSS, so the HtmlAsset unitless `line-height`
// problem (PR #109) does not apply.

export const HOOK_CAPTION_PRESET = UGC_HOOK_PRESET;
export const WALL_TEXT_PRESET = UGC_CAPTION_PRESET;

function preset(key: string) {
  const found = BUILT_IN_PRESETS.find((p) => p.key === key);
  if (!found) throw new ValidationError(`Built-in overlay preset ${key} is missing`);
  return found;
}

/** The preset row's name (text_overlays.presetId points at the seeded row with this name). */
export const presetName = (key: string): string => preset(key).name;

/** Stroke around the letters (px at 1080 wide), the classic TikTok outline. */
export const CLASSIC_STROKE_PX = 3;

const FORMAT_LOOK = {
  strokeColor: '#000000',
  strokeWidthPx: CLASSIC_STROKE_PX,
  shadowColor: null,
  backgroundType: 'none',
  backgroundColor: null,
  alignment: 'center',
  anchorX: 0.5,
} as const;

/**
 * 22.1: the hook line. Upper-middle of the frame (below the AI label and the platform's top bar,
 * above the creator's face, which the reaction prompt keeps in the lower middle); a stacked
 * layout puts it on the seam between the hook (top half) and the demo (bottom half).
 */
export const HOOK_CAPTION_ANCHOR_Y = 0.2;
export const STACKED_HOOK_CAPTION_ANCHOR_Y = 0.5;
export const HOOK_CAPTION_FONT_PCT = 5.2;

/** 22.2: the wall-of-text block, centred a little above the middle (clear of the caption bar). */
export const WALL_TEXT_ANCHOR_Y = 0.45;
/** Font size by the block's length: 20–60 words must fit the safe area without shrinking away. */
export function wallTextFontPct(words: number): number {
  if (words <= 25) return 4.4;
  if (words <= 40) return 3.8;
  return 3.3;
}

export function hookCaptionStyle(stacked: boolean): OverlayStyle {
  return resolveStyle(preset(HOOK_CAPTION_PRESET).parameters, FORMAT_LOOK, {
    fontWeight: 700,
    fontSizePct: HOOK_CAPTION_FONT_PCT,
    anchorY: stacked ? STACKED_HOOK_CAPTION_ANCHOR_Y : HOOK_CAPTION_ANCHOR_Y,
  });
}

export function wallTextStyle(words: number): OverlayStyle {
  return resolveStyle(preset(WALL_TEXT_PRESET).parameters, FORMAT_LOOK, {
    fontWeight: 600,
    fontSizePct: wallTextFontPct(words),
    anchorY: WALL_TEXT_ANCHOR_Y,
    // A soft fade so the block does not pop in on the first frame.
    animationIn: 'fadeIn',
    animationInMs: 300,
  });
}

/** One on-screen overlay row (never a narration caption: caption_sync does not judge it). */
export function classicOverlayRow(input: {
  shotId: string;
  text: string;
  startAtSec: number;
  endAtSec: number;
  style: OverlayStyle;
  presetId?: string | null;
  lang?: string;
}): Prisma.TextOverlayCreateManyInput {
  const { effect, ...style } = input.style;
  return {
    shotId: input.shotId,
    presetId: input.presetId ?? null,
    text: input.text,
    ...(input.lang && { lang: input.lang }),
    startAtSec: input.startAtSec,
    endAtSec: input.endAtSec,
    sortOrder: 0,
    kind: ON_SCREEN_KIND,
    ...style,
    effect: (effect ?? undefined) as Prisma.InputJsonValue | undefined,
  };
}

/** The seeded built-in preset row's id for a key, or null when presets are not seeded. */
export async function builtInPresetId(
  tx: Pick<Prisma.TransactionClient, 'overlayPreset'>,
  key: string,
): Promise<string | null> {
  const row = await tx.overlayPreset.findFirst({
    where: { scope: 'BUILT_IN', name: presetName(key) },
    select: { id: true },
  });
  return row?.id ?? null;
}
