import { SCRIPT_FONTS, isRtl, textFontFor } from '../i18n/scripts';
import { findLanguage } from '../languages';

// 15.C5 — text overlays in the script's language (video_scripts.language). Builds on the shared
// script → Noto family mapping in i18n/scripts.ts (Track B, 15.B1), which the EDL cards use too.
//
// Font: a Latin brand/preset font has no Arabic, Devanagari or Han glyphs, so overlays in those
// languages are set in Noto Sans Arabic / Noto Sans Devanagari / Noto Sans SC; Latin-script
// languages keep the overlay's own (brand or preset) family. Files are hosted as
// <FamilyNoSpaces>.ttf under STUDIO_FONTS_BASE_URL (overlays/shotstack.ts fontSources and the
// FFmpeg pre-renderer read the same URL): NotoSansArabic.ttf, NotoSansDevanagari.ttf,
// NotoSansSC.ttf.
//
// Direction, per composer path (read 2026-09-28):
//   - Shotstack `rich-text` (https://shotstack.io/docs/api/ RichTextAsset): no direction/rtl/
//     language property exists (font, style, stroke, shadow, background, border, padding,
//     align, animation only); the `html` asset is deprecated. The guide
//     (https://shotstack.io/docs/guide/architecting-an-application/rich-text/) says Shotstack
//     "supports everything from Arabic calligraphy to Devanagari ligatures, as long as the font
//     provides the necessary glyphs". So the paragraph direction comes from the text itself:
//     under the Unicode Bidirectional Algorithm (UAX #9, rules P2–P3) it is set by the first
//     strong character. Arabic text is prefixed with U+200F RIGHT-TO-LEFT MARK (a strong R,
//     zero-width) so a line starting with a Latin brand name or a number still lays out RTL.
//     Whether Shotstack's renderer honours the mark is not documented — verify with a test
//     render at GATE before relying on mixed-script Arabic lines.
//   - FFmpeg drawtext pre-render (https://ffmpeg.org/ffmpeg-filters.html#drawtext, FFmpeg 8.0):
//     `text_shaping` "If set to 1, attempt to shape the text (for example, reverse the order of
//     right-to-left text and join Arabic characters) … By default 1 (if supported)", and needs
//     FFmpeg built with --enable-libfribidi; the filter itself needs --enable-libharfbuzz (which
//     shapes Devanagari conjuncts). prerender.ts sets text_shaping=1 explicitly for RTL, so an
//     FFmpeg without fribidi fails loudly instead of drawing reversed, unjoined Arabic.
//
// Known limits: karaoke splits words on spaces, so Mandarin (no spaces) highlights a whole line
// at once; overlay alignment left/right is kept as the user set it (not mirrored for RTL).

export const RIGHT_TO_LEFT_MARK = '‏';

export type TextDirection = 'ltr' | 'rtl';

export interface ScriptTypography {
  fontFamily: string;
  direction: TextDirection;
}

/** Font family and direction for overlay text in `language` (Latin keeps `brandFont`). */
export function overlayTypography(
  language: string | null | undefined,
  brandFont: string,
): ScriptTypography {
  return {
    fontFamily: textFontFor(language, brandFont),
    direction: isRtl(language) ? 'rtl' : 'ltr',
  };
}

/**
 * The overlay set for its language. No language (or an unknown tag) leaves it unchanged, so
 * callers that do not know the script language keep today's behaviour.
 */
export function withScriptTypography<T extends { fontFamily: string; direction?: TextDirection }>(
  overlay: T,
  language: string | null | undefined,
): T {
  if (!findLanguage(language)) return overlay;
  const typography = overlayTypography(language, overlay.fontFamily);
  if (typography.fontFamily === overlay.fontFamily && typography.direction === 'ltr')
    return overlay;
  return { ...overlay, ...typography };
}

/** Text for a composer without a direction field: RTL paragraphs start with U+200F. */
export function directionalText(text: string, direction: TextDirection | undefined): string {
  if (direction !== 'rtl' || text.startsWith(RIGHT_TO_LEFT_MARK)) return text;
  return `${RIGHT_TO_LEFT_MARK}${text}`;
}

/** Font files the fonts host must serve for non-Latin languages (<FamilyNoSpaces>.ttf). */
export function scriptFontFiles(): string[] {
  return (['arabic', 'devanagari', 'han'] as const).map(
    (script) => `${SCRIPT_FONTS[script].replace(/ /g, '')}.ttf`,
  );
}
