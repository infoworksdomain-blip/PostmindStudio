import { PLATFORM_GAPS } from './not-built-data-ops';
import { PRODUCT_GAPS } from './not-built-data-product';
import type { Blocker, NotBuiltGroup, NotBuiltItem } from './not-built-types';

// Every feature of PostMind Studio that is not built (or built but not yet run), with why and a
// plan to complete it. Reusable outside the demo: import { NOT_BUILT } from 'demo/tour/not-built-data'.

export type { Blocker, CompletionPlan, NotBuiltGroup, NotBuiltItem } from './not-built-types';

export const NOT_BUILT: readonly NotBuiltItem[] = [...PRODUCT_GAPS, ...PLATFORM_GAPS];

export const GROUP_ORDER: readonly NotBuiltGroup[] = [
  'Notifications',
  'Create and review',
  'Library and images',
  'Manage',
  'Business set-up',
  'Admin Centre',
  'Publishing and automation',
  'Pipeline and media',
  'Cost controls',
  'Infrastructure',
  'Staging and people (GATE 12)',
];

export const BLOCKERS: readonly Blocker[] = [
  'missing endpoint',
  'blocked on a dependency',
  'not started',
  'needs staging',
  'needs people',
];

export function totalDays(items: readonly NotBuiltItem[]): number {
  return items.reduce((sum, i) => sum + i.plan.days, 0);
}
