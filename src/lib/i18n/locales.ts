import { match } from '@formatjs/intl-localematcher';
import { findLanguage, type StudioLanguage } from '../studio/languages';

// BACKLOG 16.1 — the Studio interface locales (operator decision 2026-09-28: no Nigerian
// Pidgin). en-GB is the source catalogue and the default. Codes are BCP 47 tags and are the same
// tags the video content languages use (src/lib/studio/languages.ts), so a user's interface
// locale can pre-select the content language of a new project (CONTENT_LANGUAGE_FOR_LOCALE).

export const LOCALES = [
  'en-GB',
  'en-US',
  'fr',
  'es',
  'ar',
  'de',
  'it',
  'pt-BR',
  'pt-PT',
  'hi',
  'zh-Hans',
] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en-GB';

/** Cookie holding the user's explicit interface-language choice (1 year, path /). */
export const LOCALE_COOKIE = 'studio.locale';
export const LOCALE_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;

export type TextDirection = 'ltr' | 'rtl';

export interface LocaleInfo {
  code: Locale;
  /** The language's name in its own language (the switcher shows these, never translated). */
  label: string;
  dir: TextDirection;
}

export const LOCALE_INFO: Record<Locale, LocaleInfo> = {
  'en-GB': { code: 'en-GB', label: 'English (UK)', dir: 'ltr' },
  'en-US': { code: 'en-US', label: 'English (US)', dir: 'ltr' },
  fr: { code: 'fr', label: 'Français', dir: 'ltr' },
  es: { code: 'es', label: 'Español', dir: 'ltr' },
  ar: { code: 'ar', label: 'العربية', dir: 'rtl' },
  de: { code: 'de', label: 'Deutsch', dir: 'ltr' },
  it: { code: 'it', label: 'Italiano', dir: 'ltr' },
  'pt-BR': { code: 'pt-BR', label: 'Português (Brasil)', dir: 'ltr' },
  'pt-PT': { code: 'pt-PT', label: 'Português (Portugal)', dir: 'ltr' },
  hi: { code: 'hi', label: 'हिन्दी', dir: 'ltr' },
  'zh-Hans': { code: 'zh-Hans', label: '中文（简体）', dir: 'ltr' },
};

/** Interface locale → content-language code (languages.ts). Identical tags today. */
export const CONTENT_LANGUAGE_FOR_LOCALE: Record<Locale, string> = {
  'en-GB': 'en-GB',
  'en-US': 'en-US',
  fr: 'fr',
  es: 'es',
  ar: 'ar',
  de: 'de',
  it: 'it',
  'pt-BR': 'pt-BR',
  'pt-PT': 'pt-PT',
  hi: 'hi',
  'zh-Hans': 'zh-Hans',
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function directionOf(locale: Locale): TextDirection {
  return LOCALE_INFO[locale].dir;
}

/** The video content language matching an interface locale. */
export function contentLanguageFor(locale: Locale): StudioLanguage | undefined {
  return findLanguage(CONTENT_LANGUAGE_FOR_LOCALE[locale]);
}

const MAX_ACCEPT_LANGUAGE_ENTRIES = 20;

/** Accept-Language → tags in preference order (q-values honoured, `*` and q=0 dropped). */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .slice(0, MAX_ACCEPT_LANGUAGE_ENTRIES)
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith('q='))
        ?.slice(2);
      const quality = q === undefined ? 1 : Number(q);
      return { tag: tag.trim(), quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter((e) => e.tag && e.tag !== '*' && e.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
    .map((e) => e.tag);
}

/**
 * Best supported locale for an Accept-Language header (BCP 47 lookup via the formatjs matcher,
 * so zh-CN → zh-Hans, pt → pt-BR by likely subtags, en-AU → en-GB). Falls back to en-GB.
 */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  // A bare "en" would resolve to en-US through likely subtags; Studio's English is en-GB.
  const requested = parseAcceptLanguage(acceptLanguage).map((tag) =>
    tag.toLowerCase() === 'en' ? DEFAULT_LOCALE : tag,
  );
  if (requested.length === 0) return DEFAULT_LOCALE;
  try {
    const best = match(requested, [...LOCALES], DEFAULT_LOCALE, { algorithm: 'best fit' });
    return isLocale(best) ? best : DEFAULT_LOCALE;
  } catch {
    // A malformed tag (RangeError from Intl.getCanonicalLocales) means no usable preference.
    return DEFAULT_LOCALE;
  }
}

/** Cookie choice first, then Accept-Language, then en-GB (plans/phase-16.md 16.1). */
export function resolveLocale(input: {
  cookie?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  if (isLocale(input.cookie)) return input.cookie;
  return negotiateLocale(input.acceptLanguage);
}

/** `document.cookie` assignment persisting the choice (SameSite=Lax; not HttpOnly — UI state). */
export function localeCookieString(locale: Locale, secure: boolean): string {
  return `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE_S}; SameSite=Lax${secure ? '; Secure' : ''}`;
}
