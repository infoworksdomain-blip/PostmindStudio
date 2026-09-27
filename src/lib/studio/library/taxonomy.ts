import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ValidationError } from '../../errors';

// BACKLOG 9.7 / Addendum A3.4 — the library category tree ships as prisma/data/
// library-taxonomy.json (editable). Slugs are derived from names and joined by '/'.
// Seeding upserts by slug and never deletes, so existing items keep their categories.

export interface TaxonomyNode {
  name: string;
  children?: TaxonomyNode[];
}

const node: z.ZodType<TaxonomyNode> = z.lazy(() =>
  z.object({
    name: z.string().trim().min(1).max(80),
    children: z.array(node).optional(),
  }),
);
export const taxonomyFile = z.object({ categories: z.array(node).min(1) });

export function slugPart(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface FlatCategory {
  slug: string;
  name: string;
  parentSlug: string | null;
  depth: number;
  sortOrder: number;
}

export function flattenTaxonomy(nodes: TaxonomyNode[]): FlatCategory[] {
  const out: FlatCategory[] = [];
  const walk = (list: TaxonomyNode[], parentSlug: string | null, depth: number) => {
    list.forEach((n, index) => {
      const slug = parentSlug ? `${parentSlug}/${slugPart(n.name)}` : slugPart(n.name);
      if (!slugPart(n.name)) throw new ValidationError(`Category "${n.name}" has no slug`);
      if (out.some((c) => c.slug === slug)) throw new ValidationError(`Duplicate category ${slug}`);
      out.push({ slug, name: n.name, parentSlug, depth, sortOrder: index });
      walk(n.children ?? [], slug, depth + 1);
    });
  };
  walk(nodes, null, 0);
  return out;
}

export async function seedTaxonomy(
  db: Pick<PrismaClient, 'videoLibraryCategory'>,
  raw: unknown,
): Promise<{ total: number; created: number }> {
  const parsed = taxonomyFile.safeParse(raw);
  if (!parsed.success) throw new ValidationError('library-taxonomy.json is invalid');
  const flat = flattenTaxonomy(parsed.data.categories);
  const ids = new Map<string, string>();
  let created = 0;
  for (const c of flat) {
    const parentId = c.parentSlug ? (ids.get(c.parentSlug) ?? null) : null;
    const existing = await db.videoLibraryCategory.findUnique({
      where: { slug: c.slug },
      select: { id: true },
    });
    const row = await db.videoLibraryCategory.upsert({
      where: { slug: c.slug },
      create: { slug: c.slug, name: c.name, parentId, depth: c.depth, sortOrder: c.sortOrder },
      update: { name: c.name, parentId, depth: c.depth, sortOrder: c.sortOrder },
      select: { id: true },
    });
    if (!existing) created += 1;
    ids.set(c.slug, row.id);
  }
  return { total: flat.length, created };
}

/** GET /library/categories — the tree, children nested in sortOrder. */
export async function categoryTree(db: Pick<PrismaClient, 'videoLibraryCategory'>) {
  const rows = await db.videoLibraryCategory.findMany({
    orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }],
    select: { id: true, slug: true, name: true, parentId: true, depth: true },
  });
  type Tree = (typeof rows)[number] & { children: Tree[] };
  const byId = new Map<string, Tree>(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots: Tree[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}
