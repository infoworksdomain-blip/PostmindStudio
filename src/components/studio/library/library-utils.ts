import type { CategoryNode, ReferenceMode } from './types';

// Small pure helpers for the library screens.

export interface CategoryOption {
  slug: string;
  label: string;
  depth: number;
}

/** Depth-first flatten of the category tree for a <select>, indenting children. */
export function flattenCategories(nodes: CategoryNode[]): CategoryOption[] {
  const out: CategoryOption[] = [];
  const walk = (list: CategoryNode[]) => {
    for (const node of list) {
      out.push({ slug: node.slug, label: node.name, depth: node.depth });
      walk(node.children ?? []);
    }
  };
  walk(nodes);
  return out;
}

/** 'HOOK_TEXT_ON_STILL' → 'Hook text on still'; 'fast-cut' → 'Fast cut'. */
export function humanise(value: string | null | undefined): string {
  if (!value) return '—';
  const text = value.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The Create screen reads ?reference=<id>&mode=TEMPLATE|INSPIRE. */
export function referenceHref(id: string, mode: ReferenceMode): string {
  const params = new URLSearchParams({ reference: id, mode });
  return `/new?${params.toString()}`;
}

export type DurationFilterKey = 'any' | 'short' | 'medium' | 'long' | 'xl';

/** Length filters; the labels are `library.filters.duration.<key>` in the catalogue. */
export const DURATION_FILTERS: Array<{ key: DurationFilterKey; min?: number; max?: number }> = [
  { key: 'any' },
  { key: 'short', max: 15 },
  { key: 'medium', min: 15, max: 30 },
  { key: 'long', min: 30, max: 60 },
  { key: 'xl', min: 60 },
];

/** Comma/space separated tag input → normalised, de-duplicated list. */
export function parseTags(input: string): string[] {
  return [
    ...new Set(
      input
        .split(/[,\n]/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}
