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

export const MODE_COPY: Record<ReferenceMode, { title: string; body: string }> = {
  TEMPLATE: {
    title: 'Same video, my content',
    body: 'Follows this video’s shot count, timing, overlays and music envelope with entirely new content for your brand.',
  },
  INSPIRE: {
    title: 'Make one like this',
    body: 'Borrows only the vibe — pace, mood, structure and music feel. Everything else is new.',
  },
};

export const DURATION_FILTERS: Array<{ key: string; label: string; min?: number; max?: number }> = [
  { key: 'any', label: 'Any length' },
  { key: 'short', label: 'Under 15s', max: 15 },
  { key: 'medium', label: '15–30s', min: 15, max: 30 },
  { key: 'long', label: '30–60s', min: 30, max: 60 },
  { key: 'xl', label: 'Over 60s', min: 60 },
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
