import { describe, expect, it } from 'vitest';
import { checkCatalogue, checkReviewList } from '@/lib/i18n/catalogue-check';
import { DEFAULT_LOCALE, LOCALES } from '@/lib/i18n/locales';
import { readCatalogue, readReviewList, TRANSLATED_LOCALES } from '../../scripts/i18n/catalogues';

// BACKLOG 16.4 — `npm test` fails when a catalogue drifts from en-GB: missing or extra keys,
// invalid ICU, placeholder mismatch, plural categories, or keys missing from a review list.

const source = readCatalogue(DEFAULT_LOCALE);

describe('message catalogues', () => {
  it.each(LOCALES)('%s matches en-GB and is valid ICU', (locale) => {
    const problems = checkCatalogue(locale, readCatalogue(locale), source);
    expect(problems.map((p) => `${p.kind} ${p.key}: ${p.detail}`)).toEqual([]);
  });

  it.each(TRANSLATED_LOCALES)('%s has a review list covering every key', (locale) => {
    const problems = checkReviewList(locale, readCatalogue(locale), readReviewList(locale));
    expect(problems.map((p) => `${p.key}: ${p.detail}`)).toEqual([]);
  });

  it('keeps the same namespaces, in the same order, in every catalogue', () => {
    for (const locale of LOCALES) {
      expect(Object.keys(readCatalogue(locale))).toEqual(Object.keys(source));
    }
  });
});
