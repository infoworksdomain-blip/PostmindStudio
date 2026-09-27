import { describe, expect, it } from 'vitest';
import { flattenCategories, humanise, parseTags, referenceHref } from './library-utils';

describe('library utils', () => {
  it('flattens the category tree depth-first', () => {
    const tree = [
      {
        id: '1',
        slug: 'a',
        name: 'A',
        parentId: null,
        depth: 0,
        children: [{ id: '2', slug: 'a/b', name: 'B', parentId: '1', depth: 1, children: [] }],
      },
      { id: '3', slug: 'c', name: 'C', parentId: null, depth: 0, children: [] },
    ];
    expect(flattenCategories(tree).map((c) => c.slug)).toEqual(['a', 'a/b', 'c']);
  });

  it('humanises enum-ish tags', () => {
    expect(humanise('HOOK_TEXT_ON_STILL')).toBe('Hook text on still');
    expect(humanise('fast-cut')).toBe('Fast cut');
    expect(humanise(null)).toBe('—');
  });

  it('builds the Create link for a reference', () => {
    expect(referenceHref('lib 1', 'INSPIRE')).toBe('/new?reference=lib+1&mode=INSPIRE');
  });

  it('normalises and de-duplicates tags', () => {
    expect(parseTags(' Coffee, latte,coffee,, ')).toEqual(['coffee', 'latte']);
  });
});
