// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { IntlTestProvider } from '../../../test/i18n-wrapper';
import type { Locale } from '@/lib/i18n/locales';
import { formatDate, formatPence, relativeTime, useFormat } from './format';

// BACKLOG 16.4 — formatting per locale: dates, currency (always GBP), relative time, durations,
// state labels and ICU plurals.

function inLocale(locale: Locale) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <IntlTestProvider locale={locale}>{children}</IntlTestProvider>;
  };
}

const format = (locale: Locale) =>
  renderHook(() => useFormat(), { wrapper: inLocale(locale) }).result.current;

const NBSP = /[  ]/g;
const plain = (s: string) => s.replace(NBSP, ' ');

describe('plain formatters with a locale', () => {
  it('keeps GBP in every locale, presented the locale’s way', () => {
    expect(formatPence(123450)).toBe('£1,234.50');
    expect(plain(formatPence(123450, 'fr'))).toBe('1 234,50 £GB');
    expect(plain(formatPence(123450, 'de'))).toBe('1.234,50 £');
    expect(formatPence(123450, 'zh-Hans')).toContain('1,234.50');
  });

  it('formats dates in the locale', () => {
    const iso = '2026-03-05T14:30:00Z';
    const opts: Intl.DateTimeFormatOptions = { dateStyle: 'long', timeZone: 'UTC' };
    expect(formatDate(iso, 'en-GB', opts)).toBe('5 March 2026');
    expect(formatDate(iso, 'en-US', opts)).toBe('March 5, 2026');
    expect(formatDate(iso, 'fr', opts)).toBe('5 mars 2026');
    expect(formatDate(iso, 'zh-Hans', opts)).toBe('2026年3月5日');
  });

  it('formats relative time in the locale', () => {
    const now = Date.parse('2026-03-05T12:00:00Z');
    expect(relativeTime('2026-03-04T12:00:00Z', now)).toBe('yesterday');
    expect(relativeTime('2026-03-04T12:00:00Z', now, { locale: 'fr' })).toBe('hier');
    expect(relativeTime('2026-03-05T12:00:30Z', now, { justNow: 'à l’instant' })).toBe(
      'à l’instant',
    );
  });
});

describe('useFormat', () => {
  it('binds formatters to the active locale', () => {
    const f = format('fr');
    expect(f.locale).toBe('fr');
    expect(plain(f.pence(500))).toBe('5,00 £GB');
    expect(f.list(['A', 'B', 'C'])).toBe('A, B et C');
    expect(plain(f.percent(0.5))).toBe('50 %');
  });

  it('localises durations with the catalogue’s units', () => {
    expect(format('en-GB').duration(3900)).toBe('1h 05m');
    expect(format('en-GB').duration(187)).toBe('3:07');
    expect(format('en-GB').duration(42)).toBe('42s');
    expect(format('zh-Hans').duration(42)).toBe('42 秒');
  });

  it('localises project and publication states, keeping the tone', () => {
    expect(format('en-GB').projectState('READY_FOR_REVIEW')).toEqual({
      label: 'Ready for review',
      tone: 'good',
    });
    const de = format('de').projectState('RENDERING');
    expect(de.tone).toBe('live');
    expect(de.label).not.toBe('Rendering');
    expect(format('en-US').publicationState('CANCELLED').label).toBe('Canceled');
    expect(format('fr').projectState('SOMETHING_NEW')).toEqual({
      label: 'something new',
      tone: 'neutral',
    });
  });

  it('keeps product names and falls back for unknown platforms', () => {
    expect(format('ar').platform('tiktok')).toBe('TikTok');
    expect(format('fr').platform('mastodon')).toBe('mastodon');
  });

  it('uses the placeholder and "just now" from the catalogue', () => {
    expect(format('en-GB').relative(null)).toBe('—');
    expect(format('en-GB').relative(new Date().toISOString())).toBe('just now');
    expect(format('en-GB').date(undefined)).toBe('—');
  });
});

describe('ICU plurals per locale', () => {
  const count = (locale: Locale, n: number) =>
    renderHook(() => useTranslations('common.count'), { wrapper: inLocale(locale) }).result.current(
      'items',
      { count: n },
    );

  it('English uses one/other and the zero branch', () => {
    expect(count('en-GB', 0)).toBe('No items');
    expect(count('en-GB', 1)).toBe('1 item');
    expect(count('en-GB', 5)).toBe('5 items');
  });

  it('Arabic selects distinct forms for 1, 2, 3 and 11', () => {
    const forms = [1, 2, 3, 11, 100].map((n) => count('ar', n));
    expect(new Set(forms).size).toBe(5);
  });

  it('French treats 0 and 1 as singular outside the zero branch', () => {
    expect(count('fr', 1)).not.toBe(count('fr', 2));
  });
});
