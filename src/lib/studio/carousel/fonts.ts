// Fonts for carousel slides (21.6): the bundled files in public/fonts (public/fonts/SOURCES.md),
// one stack per writing system. Inter is the clean display sans for Latin (and Greek/Cyrillic);
// Arabic, Devanagari and Han text use the Noto family Studio already sets those scripts in
// (i18n/scripts.ts), with Inter after it for Latin words and digits inside that text.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { scriptOf, type Script } from '../i18n/scripts';
import { parseFontMetrics, type FontMetrics } from './font-metrics';
import type { MeasureText } from './text';

export interface FontFace {
  /** Family name inside the file (what Pango matches). */
  readonly family: string;
  readonly file: string;
}

const INTER: FontFace = { family: 'Inter', file: 'Inter.ttf' };

export const FONT_STACKS: Readonly<Record<Script, readonly FontFace[]>> = {
  latin: [INTER, { family: 'Noto Sans', file: 'NotoSans.ttf' }],
  arabic: [{ family: 'Noto Sans Arabic', file: 'NotoSansArabic.ttf' }, INTER],
  devanagari: [{ family: 'Noto Sans Devanagari', file: 'NotoSansDevanagari.ttf' }, INTER],
  han: [{ family: 'Noto Sans SC', file: 'NotoSansSC.ttf' }, INTER],
};

/** Bold glyphs are wider than the Regular advances the metrics hold (Inter 700 vs 400: ~+6%). */
export const BOLD_WIDTH_FACTOR = 1.07;
/** Arabic joins letters into contextual forms whose widths differ from the isolated forms. */
const SHAPED_SCRIPT_FACTOR = 1.1;
/** Width of a character no font has (it is removed before rendering; this only guards maths). */
const MISSING_EM = 0.6;

export function fontsDir(): string {
  return path.join(process.cwd(), 'public', 'fonts');
}

const metricsCache = new Map<string, FontMetrics>();

export function loadMetrics(face: FontFace, dir = fontsDir()): FontMetrics {
  const key = path.join(dir, face.file);
  const cached = metricsCache.get(key);
  if (cached) return cached;
  const metrics = parseFontMetrics(readFileSync(key));
  metricsCache.set(key, metrics);
  return metrics;
}

export interface FontStack {
  readonly script: Script;
  readonly faces: readonly FontFace[];
  readonly measure: MeasureText;
  readonly covered: (codePoint: number) => boolean;
}

/** Build a measurer over metrics (first face with the glyph wins, as in Pango's fallback). */
export function measurerFor(
  metrics: readonly FontMetrics[],
  script: Script,
): { measure: MeasureText; covered: (codePoint: number) => boolean } {
  const factor = script === 'arabic' || script === 'devanagari' ? SHAPED_SCRIPT_FACTOR : 1;
  const covered = (cp: number): boolean => metrics.some((m) => m.has(cp));
  const measure: MeasureText = (text, fontSize, bold = false) => {
    let em = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      const face = metrics.find((m) => m.has(cp));
      em += face ? (face.advance(cp) ?? 0) / face.unitsPerEm : MISSING_EM;
    }
    return em * fontSize * factor * (bold ? BOLD_WIDTH_FACTOR : 1);
  };
  return { measure, covered };
}

/** The font stack for text in `language` (BCP 47 tag). */
export function fontStackFor(language: string, dir = fontsDir()): FontStack {
  const script = scriptOf(language);
  const faces = FONT_STACKS[script];
  const { measure, covered } = measurerFor(
    faces.map((f) => loadMetrics(f, dir)),
    script,
  );
  return { script, faces, measure, covered };
}
