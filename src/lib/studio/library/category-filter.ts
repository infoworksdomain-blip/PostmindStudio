import type { Prisma } from '@prisma/client';

/**
 * Category filter for the library lists: the category itself and everything under it. Slugs nest
 * with '/', so a bare prefix match would also catch a sibling that merely starts with the same
 * letters ('food' matching 'food-truck').
 */
export function categorySlugFilter(slug: string): Prisma.VideoLibraryCategoryWhereInput {
  return { OR: [{ slug }, { slug: { startsWith: `${slug}/` } }] };
}

/** Characters that mean something to LIKE; a slug never legitimately contains them. */
const LIKE_SPECIALS = /[%_\\]/g;

/**
 * Bind values for the raw-SQL category filter
 *   (${all} OR c.slug = ${exact} OR c.slug LIKE ${children})
 * the same exact-or-descendant rule as categorySlugFilter, for the pgvector queries that cannot use
 * Prisma's where input. With no slug, `all` is true and the other two never match.
 */
export function categoryLikeParams(slug: string | undefined): {
  all: boolean;
  exact: string;
  children: string;
} {
  const clean = (slug ?? '').replace(LIKE_SPECIALS, '');
  if (!clean) return { all: true, exact: '', children: '' };
  return { all: false, exact: clean, children: `${clean}/%` };
}
