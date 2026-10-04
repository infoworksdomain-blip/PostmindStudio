import type { Prisma } from '@prisma/client';
import { checkRealPersonRequest } from './real-person';
import { isUgcLanguage, type UgcInput } from './style';

// BACKLOG 21.4 — "Plan my month" (20.9) with UGC actors: when the owner ticks "UGC actors for
// testimonial and product videos" (metadata.ugcActors), the plan's VIDEO items with a testimonial
// or product-feature angle become UGC actor videos; every other item is unchanged. An item whose
// text would trip the real-person check, or a non-English plan, keeps the ordinary video style
// instead of failing.

export const UGC_PLAN_ANGLES: ReadonlySet<string> = new Set(['testimonial', 'product_feature']);

export function planUsesUgcActors(plan: { metadata: Prisma.JsonValue | null }): boolean {
  const meta = plan.metadata;
  return (
    Boolean(meta) &&
    typeof meta === 'object' &&
    !Array.isArray(meta) &&
    (meta as Record<string, unknown>).ugcActors === true
  );
}

/** The `ugc` body for one plan item, or undefined for an ordinary video. */
export function ugcForPlanItem(
  plan: { metadata: Prisma.JsonValue | null; language: string },
  item: { kind: string; angle: string; title: string; brief: string },
): UgcInput | undefined {
  if (!planUsesUgcActors(plan) || !isUgcLanguage(plan.language)) return undefined;
  if (item.kind !== 'VIDEO' || !UGC_PLAN_ANGLES.has(item.angle)) return undefined;
  if (checkRealPersonRequest(item.title, item.brief).refused) return undefined;
  return {};
}
