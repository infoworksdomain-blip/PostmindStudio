import { describe, expect, it } from 'vitest';
import { categoryLikeParams, categorySlugFilter } from './category-filter';

describe('categorySlugFilter', () => {
  it('matches the category and its descendants only, not look-alike siblings', () => {
    expect(categorySlugFilter('food')).toEqual({
      OR: [{ slug: 'food' }, { slug: { startsWith: 'food/' } }],
    });
  });
});

describe('categoryLikeParams', () => {
  it('matches everything without a slug', () => {
    expect(categoryLikeParams(undefined)).toEqual({ all: true, exact: '', children: '' });
    expect(categoryLikeParams('')).toEqual({ all: true, exact: '', children: '' });
  });

  it('matches the slug itself or its children, never a look-alike sibling', () => {
    expect(categoryLikeParams('food')).toEqual({ all: false, exact: 'food', children: 'food/%' });
  });

  it('strips LIKE wildcards so a slug cannot widen the match', () => {
    expect(categoryLikeParams('a%b_c')).toEqual({ all: false, exact: 'abc', children: 'abc/%' });
  });
});
