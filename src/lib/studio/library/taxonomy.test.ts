import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../errors';
import {
  categoryTree,
  flattenTaxonomy,
  seedTaxonomy,
  slugPart,
  taxonomyFile,
  type TaxonomyNode,
} from './taxonomy';

// BACKLOG 9.7 / Addendum A3.4 — the library category tree.

describe('slugPart', () => {
  it('lowercases, replaces non-alphanumerics with hyphens, and trims leading/trailing hyphens', () => {
    expect(slugPart('E-commerce')).toBe('e-commerce');
    expect(slugPart('Food and drink')).toBe('food-and-drink');
    expect(slugPart('  Fitness & Wellbeing! ')).toBe('fitness-wellbeing');
  });

  it('normalises accented characters via NFKD before slugifying', () => {
    expect(slugPart('Café')).toBe('cafe');
  });

  it('returns an empty string for a name with no alphanumeric characters', () => {
    expect(slugPart('***')).toBe('');
  });
});

describe('flattenTaxonomy', () => {
  it('produces slashed slugs, depth and sortOrder for a nested tree', () => {
    const nodes: TaxonomyNode[] = [
      { name: 'Business', children: [{ name: 'E-commerce', children: [{ name: 'Fashion' }] }] },
      { name: 'Lifestyle' },
    ];
    const flat = flattenTaxonomy(nodes);
    expect(flat).toEqual([
      { slug: 'business', name: 'Business', parentSlug: null, depth: 0, sortOrder: 0 },
      {
        slug: 'business/e-commerce',
        name: 'E-commerce',
        parentSlug: 'business',
        depth: 1,
        sortOrder: 0,
      },
      {
        slug: 'business/e-commerce/fashion',
        name: 'Fashion',
        parentSlug: 'business/e-commerce',
        depth: 2,
        sortOrder: 0,
      },
      { slug: 'lifestyle', name: 'Lifestyle', parentSlug: null, depth: 0, sortOrder: 1 },
    ]);
  });

  it('throws ValidationError for a name that slugifies to an empty string', () => {
    expect(() => flattenTaxonomy([{ name: '***' }])).toThrow(ValidationError);
  });

  it('throws ValidationError for duplicate slugs, including across siblings and depths', () => {
    expect(() => flattenTaxonomy([{ name: 'Fashion' }, { name: 'Fashion' }])).toThrow(
      ValidationError,
    );
    expect(() =>
      flattenTaxonomy([{ name: 'Fashion', children: [{ name: 'Shoes' }] }, { name: 'Shoes' }]),
    ).not.toThrow(); // different slugs (fashion/shoes vs shoes) — sanity check duplicates are slug-based
  });
});

describe('the real prisma/data/library-taxonomy.json', () => {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), 'prisma/data/library-taxonomy.json'), 'utf8'),
  ) as unknown;

  it('parses with taxonomyFile', () => {
    const parsed = taxonomyFile.safeParse(raw);
    expect(parsed.success).toBe(true);
  });

  it('has between 190 and 210 total nodes', () => {
    const parsed = taxonomyFile.parse(raw);
    const flat = flattenTaxonomy(parsed.categories);
    expect(flat.length).toBeGreaterThanOrEqual(190);
    expect(flat.length).toBeLessThanOrEqual(210);
  });

  it('has exactly 8 top-level categories named per Addendum A3.4', () => {
    const parsed = taxonomyFile.parse(raw);
    expect(parsed.categories.map((c) => c.name)).toEqual([
      'Business',
      'Lifestyle',
      'Education',
      'Entertainment',
      'News and commentary',
      'Personal brand',
      'Product marketing',
      'Community',
    ]);
  });
});

function fakeCategoryDb() {
  const rows = new Map<string, { id: string; parentId: string | null }>();
  let counter = 0;
  const videoLibraryCategory = {
    findUnique: vi.fn(async ({ where }: { where: { slug: string } }) => {
      const row = rows.get(where.slug);
      return row ? { id: row.id } : null;
    }),
    upsert: vi.fn(
      async ({
        where,
        create,
      }: {
        where: { slug: string };
        create: { parentId: string | null };
      }) => {
        const existing = rows.get(where.slug);
        if (existing) return { id: existing.id };
        counter += 1;
        const id = `cat-${counter}`;
        rows.set(where.slug, { id, parentId: create.parentId });
        return { id };
      },
    ),
  };
  return { db: { videoLibraryCategory } as unknown as PrismaClient, videoLibraryCategory, rows };
}

describe('seedTaxonomy', () => {
  const tree = { categories: [{ name: 'Business', children: [{ name: 'E-commerce' }] }] };

  it('throws ValidationError for input that fails the schema', async () => {
    const { db } = fakeCategoryDb();
    await expect(seedTaxonomy(db, { categories: [] })).rejects.toBeInstanceOf(ValidationError);
  });

  it('counts every node as created on first seed', async () => {
    const { db } = fakeCategoryDb();
    const result = await seedTaxonomy(db, tree);
    expect(result).toEqual({ total: 2, created: 2 });
  });

  it('counts nothing as newly created when re-seeding with the same tree', async () => {
    const { db } = fakeCategoryDb();
    await seedTaxonomy(db, tree);
    const result = await seedTaxonomy(db, tree);
    expect(result).toEqual({ total: 2, created: 0 });
  });

  it('passes the parent id resolved from the previously-seeded parent to the child upsert', async () => {
    const { db, videoLibraryCategory } = fakeCategoryDb();
    await seedTaxonomy(db, tree);
    const childCall = videoLibraryCategory.upsert.mock.calls.find(
      (c) => c[0].where.slug === 'business/e-commerce',
    );
    expect(childCall?.[0].create.parentId).toBe('cat-1');
  });
});

describe('categoryTree', () => {
  it('nests children under parents in depth then sortOrder', async () => {
    const rows = [
      { id: 'root', slug: 'business', name: 'Business', parentId: null, depth: 0 },
      { id: 'child-b', slug: 'business/services', name: 'Services', parentId: 'root', depth: 1 },
      {
        id: 'child-a',
        slug: 'business/e-commerce',
        name: 'E-commerce',
        parentId: 'root',
        depth: 1,
      },
      { id: 'root2', slug: 'lifestyle', name: 'Lifestyle', parentId: null, depth: 0 },
    ];
    const videoLibraryCategory = { findMany: vi.fn(async () => rows) };
    const tree = await categoryTree({ videoLibraryCategory } as unknown as Pick<
      PrismaClient,
      'videoLibraryCategory'
    >);
    expect(tree.map((r) => r.slug)).toEqual(['business', 'lifestyle']);
    expect(tree[0]?.children.map((c) => c.slug)).toEqual([
      'business/services',
      'business/e-commerce',
    ]);
    expect(tree[1]?.children).toEqual([]);
  });
});
