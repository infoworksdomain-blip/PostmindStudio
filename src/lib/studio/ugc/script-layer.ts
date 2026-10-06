import type { Prisma, VisualTreatment } from '@prisma/client';
import type { PlanTier } from '../providers/router';
import type { ProviderRegistry } from '../providers/registry';
import { aiClipBudget, applyClipBudget } from '../pipeline/clip-budget';
import { availableTreatments, type PlannedScript } from '../pipeline/scripting';
import {
  actorClipBudget,
  actorClipSeconds,
  applyUgcPlan,
  ugcTreatments,
  ugcUsesReferenceImage,
} from './plan';
import { ugcScriptSupplement } from './prompt';
import { ugcStyleOf, type UgcStyle } from './style';

// BACKLOG 21.4 — what Layer 2 does differently for a UGC actor video, in one place for the first
// plan (plan-project.ts) and a script rewrite (regenerate-script.ts): the treatments offered,
// the clip budget (actor clips instead of AI clips), the prompt supplement and the post-parse
// rules. An ordinary video gets exactly the 20.25 behaviour.

export interface ScriptLayerMode {
  ugc: UgcStyle | null;
  treatments: VisualTreatment[];
  /** AI clips (ordinary) or actor clips (UGC) a script of this length may use. */
  budget(durationSec: number): number;
  /** The script prompt's extra block (UGC only). */
  supplement(durationSec: number, budget: number): string | undefined;
  /** Enforce the budget and the style's rules on a parsed script. */
  apply(
    plan: PlannedScript,
    input: { budget: number; targetSec: number; keepDurations?: boolean },
  ): { plan: PlannedScript; converted: number };
}

/** The project's UGC style (every active subscriber may use it; the tier sets the clip budget). */
export function activeUgcStyle(metadata: Prisma.JsonValue | null | undefined): UgcStyle | null {
  return ugcStyleOf(metadata);
}

export function scriptLayerMode(input: {
  metadata: Prisma.JsonValue | null | undefined;
  tier: PlanTier;
  registry: Pick<ProviderRegistry, 'getAdaptersByCapability'>;
}): ScriptLayerMode {
  const general = availableTreatments(input.registry as ProviderRegistry);
  const ugc = activeUgcStyle(input.metadata);
  if (!ugc) {
    return {
      ugc: null,
      treatments: general,
      budget: (durationSec) => aiClipBudget(input.tier, durationSec),
      supplement: () => undefined,
      apply: (plan, options) => applyClipBudget(plan, options),
    };
  }
  const treatments = ugcTreatments(input.registry);
  const clipSeconds = actorClipSeconds(ugcUsesReferenceImage(ugc.product.imageId, input.registry));
  return {
    ugc,
    treatments,
    budget: (durationSec) => actorClipBudget(input.tier, durationSec),
    supplement: (_durationSec, budget) =>
      ugcScriptSupplement({ style: ugc, clipSeconds, actorClipBudget: budget, treatments }),
    apply: (plan, options) => applyUgcPlan(plan, { ...options, clipSeconds }),
  };
}
