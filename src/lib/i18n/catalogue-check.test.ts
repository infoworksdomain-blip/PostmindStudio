import { describe, expect, it } from 'vitest';
import {
  analyseMessage,
  buildReviewList,
  checkCatalogue,
  checkReviewList,
  flatten,
  pluralCategoriesFor,
  type Catalogue,
} from './catalogue-check';

const source: Catalogue = {
  a: { title: 'Hello {name}', count: '{n, plural, one {# item} other {# items}}' },
  empty: {},
};

const kinds = (locale: string, c: Catalogue) =>
  checkCatalogue(locale, c, source).map((p) => p.kind);

describe('checkCatalogue', () => {
  it('accepts a matching catalogue', () => {
    const fr: Catalogue = {
      a: { title: 'Bonjour {name}', count: '{n, plural, one {# élément} other {# éléments}}' },
      empty: {},
    };
    expect(checkCatalogue('fr', fr, source)).toEqual([]);
  });

  it('reports missing and extra keys', () => {
    const c: Catalogue = { a: { title: 'Hi {name}', extra: 'x' }, empty: {} };
    expect(checkCatalogue('de', c, source)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'missing', key: 'a.count' }),
        expect.objectContaining({ kind: 'extra', key: 'a.extra' }),
      ]),
    );
  });

  it('reports a namespace turned into a string', () => {
    expect(kinds('de', { a: 'oops', empty: {} })).toContain('type');
  });

  it('reports invalid ICU syntax', () => {
    const c: Catalogue = {
      a: { title: 'Hallo {name', count: '{n, plural, one {#} other {#}}' },
      empty: {},
    };
    expect(kinds('de', c)).toContain('invalid_icu');
  });

  it('reports renamed or dropped placeholders', () => {
    const c: Catalogue = {
      a: { title: 'Hallo {nom}', count: '{n, plural, one {# Element} other {# Elemente}}' },
      empty: {},
    };
    expect(checkCatalogue('de', c, source)).toEqual([
      expect.objectContaining({ kind: 'placeholders', key: 'a.title' }),
    ]);
  });

  it('requires the locale’s plural categories (Arabic needs six)', () => {
    const c: Catalogue = {
      a: { title: 'مرحبا {name}', count: '{n, plural, one {عنصر} other {# عنصر}}' },
      empty: {},
    };
    const problem = checkCatalogue('ar', c, source).find((p) => p.kind === 'plural_categories');
    expect(problem?.detail).toContain('zero, two, few, many');
  });

  it('flags categories the locale never selects (zh has only other)', () => {
    const c: Catalogue = {
      a: { title: '你好 {name}', count: '{n, plural, one {# 项} other {# 项}}' },
      empty: {},
    };
    expect(kinds('zh-Hans', c)).toContain('plural_categories');
  });

  it('flags the ASCII apostrophe, which ICU treats as an escape', () => {
    const c: Catalogue = {
      a: { title: "l'{name}", count: '{n, plural, one {#} other {#}}' },
      empty: {},
    };
    expect(kinds('fr', c)).toEqual(expect.arrayContaining(['ascii_apostrophe', 'placeholders']));
  });
});

describe('helpers', () => {
  it('flattens leaf keys and skips empty namespaces', () => {
    expect([...flatten(source).keys()]).toEqual(['a.title', 'a.count']);
  });

  it('collects arguments nested in plural branches', () => {
    const a = analyseMessage('{n, plural, one {{who} liked it} other {{who} and # others}}');
    expect([...a.args].sort()).toEqual(['n', 'who']);
    expect(a.plurals).toEqual([{ argument: 'n', categories: ['one', 'other'] }]);
  });

  it('makes many optional where CLDR only uses it for large compact numbers', () => {
    expect(pluralCategoriesFor('fr').required).toEqual(['one', 'other']);
    expect(pluralCategoriesFor('ar').required).toEqual([
      'zero',
      'one',
      'two',
      'few',
      'many',
      'other',
    ]);
  });
});

describe('review lists', () => {
  it('keeps reviewed keys, queues the rest and drops deleted ones', () => {
    const list = buildReviewList('fr', source, {
      locale: 'fr',
      needs_review: [],
      reviewed: ['a.title', 'a.gone'],
    });
    expect(list).toEqual({ locale: 'fr', needs_review: ['a.count'], reviewed: ['a.title'] });
  });

  it('reports a missing list and unlisted keys', () => {
    expect(checkReviewList('fr', source, undefined)[0]?.detail).toContain('missing');
    const partial = { locale: 'fr', needs_review: ['a.title'], reviewed: [] };
    expect(checkReviewList('fr', source, partial).map((p) => p.key)).toEqual(['a.count']);
  });
});
