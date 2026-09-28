import { languageOf } from '../languages';
import { escapeHtml, roundSec } from './edl-time';

// Operator decision P6 (2026-09-28): the platform AI labels (TikTok is_aigc, YouTube
// containsSyntheticMedia, Meta is_ai_generated) stay always on; a brand kit may also add a small
// on-video "AI-generated" label (brand_kits.aiDisclosureLabel, default off), written in the
// video's language. Rendered as a Shotstack `html` asset (the same documented asset as the text
// cards), top-centre: the logo bug is top-right, the watermark top-left, captions bottom.

const LABELS: Readonly<Record<string, string>> = {
  en: 'AI-generated',
  fr: 'Généré par IA',
  es: 'Generado por IA',
  ar: 'مُنشأ بالذكاء الاصطناعي',
  de: 'KI-generiert',
  it: 'Generato con IA',
  pt: 'Gerado por IA',
  hi: 'एआई से निर्मित',
  zh: 'AI生成',
};

/** The label text for a language tag (English for anything unknown). */
export function aiLabelText(lang: string | null | undefined): string {
  return LABELS[languageOf(lang).base] ?? (LABELS.en as string);
}

export function aiLabelClip(input: {
  lang: string | null | undefined;
  startSec: number;
  lengthSec: number;
  frame: { width: number; height: number };
  fontFamily: string;
  rtl: boolean;
}): Record<string, unknown> {
  const fontPx = Math.max(14, Math.round(input.frame.height * 0.018));
  const dir = input.rtl ? ' dir="rtl"' : '';
  return {
    asset: {
      type: 'html',
      html: `<p${dir}>${escapeHtml(aiLabelText(input.lang))}</p>`,
      css: `p { font-family: '${input.fontFamily}', sans-serif; color: #ffffff; font-size: ${fontPx}px; font-weight: 600; text-align: center; margin: 0; background: rgba(0,0,0,0.45); }`,
      width: Math.round(input.frame.width * 0.4),
      height: Math.round(fontPx * 2.2),
      position: 'center',
    },
    start: roundSec(input.startSec),
    length: roundSec(input.lengthSec),
    position: 'top',
    offset: { x: 0, y: -0.02 },
  };
}
