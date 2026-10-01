import type { Prisma } from '@prisma/client';

/**
 * Category filter for the library lists: the category itself and everything under it. Slugs nest
 * with '/', so a bare prefix match would also catch a sibling that merely starts with the same
 * letters ('food' matching 'food-truck').
 */
export function categorySlugFilter(slug: string): Prisma.VideoLibraryCategoryWhereInput {
  return { OR: [{ slug }, { slug: { startsWith: `${slug}/` } }] };
}
