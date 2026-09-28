import { describe, expect, it } from 'vitest';
import {
  contentLanguageFor,
  directionOf,
  isLocale,
  LOCALE_COOKIE,
  LOCALE_INFO,
  LOCALES,
  localeCookieString,
  negotiateLocale,
  parseAcceptLanguage,
  resolveLocale,
} from './locales';

describe('locales', () => {
  it('lists the 11 interface locales with endonyms and direction', () => {
    expect(LOCALES).toHaveLength(11);
    expect(LOCALE_INFO.ar).toEqual({ code: 'ar', label: 'العربية', dir: 'rtl' });
    expect(LOCALE_INFO['zh-Hans'].label).toBe('中文（简体）');
    expect(LOCALE_INFO.hi.label).toBe('हिन्दी');
    expect(LOCALES.filter((l) => directionOf(l) === 'rtl')).toEqual(['ar']);
  });

  it('maps every locale to a content language', () => {
    for (const locale of LOCALES) expect(contentLanguageFor(locale)?.code).toBe(locale);
    expect(contentLanguageFor('ar')?.direction).toBe('rtl');
  });

  it('recognises supported codes only', () => {
    expect(isLocale('pt-PT')).toBe(true);
    expect(isLocale('pt')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe('parseAcceptLanguage', () => {
  it('orders by quality and keeps header order for ties', () => {
    expect(parseAcceptLanguage('fr;q=0.5, de, es;q=0.9, *;q=0.1, it;q=0')).toEqual([
      'de',
      'es',
      'fr',
    ]);
  });

  it('handles missing headers', () => {
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(parseAcceptLanguage('')).toEqual([]);
  });
});

describe('negotiateLocale', () => {
  it.each([
    ['zh-CN,zh;q=0.9', 'zh-Hans'],
    ['pt-PT', 'pt-PT'],
    ['pt', 'pt-BR'],
    ['en-US,en;q=0.9', 'en-US'],
    ['en', 'en-GB'],
    ['en-AU', 'en-GB'],
    ['ar-EG', 'ar'],
    ['fr-CA', 'fr'],
    ['hi-IN', 'hi'],
    ['ja', 'en-GB'],
    ['ja, de;q=0.5', 'de'],
    ['not a tag!!', 'en-GB'],
    [undefined, 'en-GB'],
  ])('%s → %s', (header, expected) => {
    expect(negotiateLocale(header)).toBe(expected);
  });
});

describe('resolveLocale', () => {
  it('prefers the cookie, then Accept-Language, then en-GB', () => {
    expect(resolveLocale({ cookie: 'ar', acceptLanguage: 'de' })).toBe('ar');
    expect(resolveLocale({ cookie: 'klingon', acceptLanguage: 'de' })).toBe('de');
    expect(resolveLocale({})).toBe('en-GB');
  });
});

describe('localeCookieString', () => {
  it('writes a year-long, site-wide, SameSite=Lax cookie', () => {
    const cookie = localeCookieString('fr', true);
    expect(cookie).toContain(`${LOCALE_COOKIE}=fr`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=31536000');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(localeCookieString('fr', false)).not.toContain('Secure');
  });
});
