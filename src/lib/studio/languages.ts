import { z } from 'zod';

// 15.C5 (spec 3.1) — the languages Studio generates videos in. Operator decision 2026-09-28
// replaced the spec's "English (UK, US), Nigerian Pidgin, plus 20 additional languages" with
// exactly this list (Nigerian Pidgin is not offered). Codes are BCP 47 tags. Layers 1–2 write
// natively in the language (prompts below), and the media layers read `script` / `direction`
// for fonts and text direction (Arabic is right-to-left; Hindi is Devanagari; Mandarin is
// Simplified Han).

export type LanguageScript = 'latin' | 'arabic' | 'devanagari' | 'han';

export interface StudioLanguage {
  /** BCP 47 tag stored on video_projects.language / video_scripts.language. */
  code: string;
  /** English name, used in prompts and the UI. */
  name: string;
  /** Endonym, shown next to the English name in the language picker. */
  nativeName: string;
  script: LanguageScript;
  direction: 'ltr' | 'rtl';
  /** ISO 639-1 base language (ElevenLabs / AssemblyAI language codes derive from it). */
  base: string;
  /** How the model is told to write (variant and spelling conventions). */
  promptName: string;
}

export const LANGUAGES: readonly StudioLanguage[] = [
  {
    code: 'en-GB',
    name: 'English (UK)',
    nativeName: 'English (UK)',
    script: 'latin',
    direction: 'ltr',
    base: 'en',
    promptName: 'British English (UK spelling and idiom)',
  },
  {
    code: 'en-US',
    name: 'English (US)',
    nativeName: 'English (US)',
    script: 'latin',
    direction: 'ltr',
    base: 'en',
    promptName: 'American English (US spelling and idiom)',
  },
  {
    code: 'fr',
    name: 'French',
    nativeName: 'Français',
    script: 'latin',
    direction: 'ltr',
    base: 'fr',
    promptName: 'French',
  },
  {
    code: 'es',
    name: 'Spanish',
    nativeName: 'Español',
    script: 'latin',
    direction: 'ltr',
    base: 'es',
    promptName: 'Spanish',
  },
  {
    code: 'ar',
    name: 'Arabic',
    nativeName: 'العربية',
    script: 'arabic',
    direction: 'rtl',
    base: 'ar',
    promptName: 'Modern Standard Arabic (Arabic script)',
  },
  {
    code: 'de',
    name: 'German',
    nativeName: 'Deutsch',
    script: 'latin',
    direction: 'ltr',
    base: 'de',
    promptName: 'German',
  },
  {
    code: 'it',
    name: 'Italian',
    nativeName: 'Italiano',
    script: 'latin',
    direction: 'ltr',
    base: 'it',
    promptName: 'Italian',
  },
  {
    code: 'pt-BR',
    name: 'Portuguese (Brazil)',
    nativeName: 'Português (Brasil)',
    script: 'latin',
    direction: 'ltr',
    base: 'pt',
    promptName: 'Brazilian Portuguese',
  },
  {
    code: 'pt-PT',
    name: 'Portuguese (Portugal)',
    nativeName: 'Português (Portugal)',
    script: 'latin',
    direction: 'ltr',
    base: 'pt',
    promptName: 'European Portuguese (Portugal)',
  },
  {
    code: 'hi',
    name: 'Hindi',
    nativeName: 'हिन्दी',
    script: 'devanagari',
    direction: 'ltr',
    base: 'hi',
    promptName: 'Hindi (Devanagari script)',
  },
  {
    code: 'zh-Hans',
    name: 'Mandarin Chinese (Simplified)',
    nativeName: '简体中文',
    script: 'han',
    direction: 'ltr',
    base: 'zh',
    promptName: 'Mandarin Chinese in Simplified Chinese characters',
  },
];

export const DEFAULT_LANGUAGE = 'en-GB';
export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code) as [string, ...string[]];
/** Extra variant languages per project (one script set per language). */
export const MAX_EXTRA_LANGUAGES = 4;

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code.toLowerCase(), l]));

/** The supported language for a tag (case-insensitive), or undefined. */
export function findLanguage(code: string | null | undefined): StudioLanguage | undefined {
  return code ? BY_CODE.get(code.trim().toLowerCase()) : undefined;
}

/** The language for a stored tag; unknown or empty tags fall back to en-GB. */
export function languageOf(code: string | null | undefined): StudioLanguage {
  return findLanguage(code) ?? (BY_CODE.get(DEFAULT_LANGUAGE.toLowerCase()) as StudioLanguage);
}

/** zod: a supported tag, normalised to its canonical casing ("pt-br" → "pt-BR"). */
export const languageInput = z
  .string()
  .trim()
  .max(16)
  .transform((value, ctx) => {
    const found = findLanguage(value);
    if (!found) {
      ctx.addIssue({
        code: 'custom',
        message: `Unsupported language "${value}". Supported: ${LANGUAGE_CODES.join(', ')}`,
      });
      return z.NEVER;
    }
    return found.code;
  });

/** Extra languages: unique, supported, at most MAX_EXTRA_LANGUAGES. */
export const extraLanguagesInput = z
  .array(languageInput)
  .max(MAX_EXTRA_LANGUAGES)
  .refine((codes) => new Set(codes).size === codes.length, {
    message: 'Each language may appear once',
  });

/** The project's languages: primary first, extras after, without duplicates. */
export function projectLanguages(primary: string | null | undefined, extras: unknown): string[] {
  const list = [languageOf(primary).code];
  if (Array.isArray(extras)) {
    for (const value of extras) {
      const found = typeof value === 'string' ? findLanguage(value) : undefined;
      if (found && !list.includes(found.code)) list.push(found.code);
    }
  }
  return list;
}

/** The instruction given to Layers 1–2: write natively, never translate from English. */
export function languageInstruction(code: string): string {
  const language = languageOf(code);
  return [
    `Language: write every spoken and on-screen word in ${language.promptName}.`,
    'Write natively for speakers of that language: idiom, rhythm, humour and calls to action a native copywriter would use. Do not translate from English word for word.',
    language.direction === 'rtl'
      ? 'The text is right-to-left; keep brand names and numbers as the audience writes them.'
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}
