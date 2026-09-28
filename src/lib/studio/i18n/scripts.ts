import { languageOf, type LanguageScript } from '../languages';

// Shared script → font mapping for everything Studio renders as text in a video (brand cards,
// captions, motion-graphics cards, the AI-generated label, overlays). Built on 15.C5's language
// list (languages.ts: script + direction per supported language).
//
// A Latin brand font has no Arabic, Devanagari or Han glyphs, so text in those scripts is set in
// the matching Noto family (SIL Open Font License, free for commercial embedding). Shotstack has
// no system fonts: each family must be hosted as <FamilyNoSpaces>.ttf under STUDIO_FONTS_BASE_URL
// (the same convention as overlays, overlays/shotstack.ts fontSources), e.g.
// NotoSansArabic.ttf, NotoSansDevanagari.ttf, NotoSansSC.ttf, NotoSans.ttf.
// Sources: https://fonts.google.com/noto/specimen/Noto+Sans+Arabic ,
// https://fonts.google.com/noto/specimen/Noto+Sans+Devanagari ,
// https://fonts.google.com/noto/specimen/Noto+Sans+SC (read 2026-09-28).

export type Script = LanguageScript;

export const SCRIPT_FONTS: Readonly<Record<Script, string>> = {
  latin: 'Noto Sans',
  arabic: 'Noto Sans Arabic',
  devanagari: 'Noto Sans Devanagari',
  han: 'Noto Sans SC',
};

/** The writing system of a language tag (unknown tags → en-GB → latin). */
export function scriptOf(lang: string | null | undefined): Script {
  return languageOf(lang).script;
}

/** Right-to-left languages (Arabic). */
export function isRtl(lang: string | null | undefined): boolean {
  return languageOf(lang).direction === 'rtl';
}

/**
 * The font family to set text of a script in. The hosted Noto files are variable-weight, so the
 * family name is the same for every weight; `weight` is accepted for callers that pick per weight.
 */
export function fontFamilyFor(script: Script, weight = 400): string {
  void weight;
  return SCRIPT_FONTS[script];
}

/**
 * The family for text in `lang`: the brand font for Latin-script languages (when it is set),
 * otherwise the script's Noto family.
 */
export function textFontFor(lang: string | null | undefined, brandFont?: string | null): string {
  const script = scriptOf(lang);
  if (script === 'latin' && brandFont) return brandFont;
  return fontFamilyFor(script);
}
