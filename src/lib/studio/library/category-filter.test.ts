import { describe, expect, it } from 'vitest';
import { categorySlugFilter } from './category-filter';

describe('categorySlugFilter', () => {
  it('matches the category and its descendants only, not look-alike siblings', () => {
    expect(categorySlugFilter('food')).toEqual({
      OR: [{ slug: 'food' }, { slug: { startsWith: 'food/' } }],
    });
  });
});
