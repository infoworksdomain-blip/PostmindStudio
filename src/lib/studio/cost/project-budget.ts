// Operator decision 2 (2026-09-27): the per-project budget (video_projects.costBudgetPence)
// applied when the client does not set one — £3.50 for short-form, £30 for long-form.
// Applied at creation only (POST /projects incl. TEMPLATE projects, and duplicate when the
// source has no budget). An explicit costBudgetPence always wins, and existing projects are
// never rewritten.
//
// "Long-form" (documented choice): a project is long-form when ANY of its target formats is
//   · longer than 180 s — beyond the 3-minute ceiling of every short-form surface Studio targets
//     (TikTok, Reels, YouTube Shorts), or
//   · a regular YouTube upload (platform "youtube", not "youtube_short") longer than 60 s.
// Everything else is short-form.
//
// 15.D2 / Addendum A10.4: "Slideshow projects: default costBudgetPence £150 (vs £300 for AI
// video)." — read as 150 pence (£1.50), half the AI-video figure, since the field is in pence and
// operator decision 2 set the AI short-form default at 350 pence. Slideshow projects (sourceType
// SLIDESHOW) get £1.50 whatever their formats. "Library-referenced projects: default
// costBudgetPence unchanged from AI video baseline" — they follow the short/long-form rule.

import { TYPICAL_COST_PENCE_PER_VIDEO } from '../billing/catalogue';
import type { PlanTier } from '../providers/router';

export const DEFAULT_SHORT_FORM_BUDGET_PENCE = 350;
export const DEFAULT_LONG_FORM_BUDGET_PENCE = 3_000;
/**
 * BACKLOG 20.25: with the organisation's plan tier, the default is at least this many times the
 * catalogue's typical cost of one video on that tier, and never under the operator's £3.50 / £30.
 * A production STANDARD video paused at "90% of its budget (£3.15 of £3.50)" before the AI clip
 * budget; a normal video (≈ 40% of the typical cost per tier, cost/video-estimate.ts) must never
 * reach the 90% pause, even with a regenerated shot or a pricier failover provider.
 */
export const BUDGET_TYPICAL_VIDEO_MULTIPLE = 2.5;
/**
 * 21.3 (operator decision 2026-10-04: one per-channel subscription, HD video, mapped to the
 * internal STANDARD tier): every tier renders AI clips on the full Seedance 2.0 at 720p, which
 * costs more than the catalogue's §P.2 typical cost per video. These floors keep a normal 30 s
 * short under half its budget at the cautious USD→GBP 0.79 (cost/video-estimate.ts, tested there):
 * STANDARD ≈ 241p (4 clips) → £5; BASIC ≈ 187p (3 clips) → £5; PLUS / ENTERPRISE ≈ 337p (6 clips)
 * → £7. Long form keeps 2.5 × the catalogue typical cost (STANDARD 3 min ≈ 1,411p < 90% of £30;
 * PLUS 6 min ≈ 2,917p < 90% of £45).
 */
export const TIER_BUDGET_FLOOR_PENCE: Readonly<Record<PlanTier, { short: number; long: number }>> =
  {
    BASIC: { short: 500, long: 0 },
    STANDARD: { short: 500, long: 0 },
    PLUS: { short: 700, long: 0 },
    ENTERPRISE: { short: 700, long: 0 },
  };
export const DEFAULT_SLIDESHOW_BUDGET_PENCE = 150;
export const SHORT_FORM_MAX_SEC = 180;
export const YOUTUBE_LONG_FORM_MIN_SEC = 60;

/** Either shape: the API's { durationSec } or the stored spec 7.3 { duration }. */
export interface BudgetFormat {
  platform: string;
  durationSec?: number;
  duration?: number;
}

function seconds(f: BudgetFormat): number {
  return f.durationSec ?? f.duration ?? 0;
}

export function isLongForm(formats: readonly BudgetFormat[]): boolean {
  return formats.some((f) => {
    const sec = seconds(f);
    return (
      sec > SHORT_FORM_MAX_SEC || (f.platform === 'youtube' && sec > YOUTUBE_LONG_FORM_MIN_SEC)
    );
  });
}

function typicalCostPence(tier: PlanTier, kind: 'short' | 'long'): number {
  return TYPICAL_COST_PENCE_PER_VIDEO[tier === 'ENTERPRISE' ? 'PLUS' : tier][kind];
}

/** 20.25 / 21.3: the short-form default for a tier (BASIC / STANDARD £5, PLUS / ENTERPRISE £7). */
export function shortFormBudgetPence(tier?: PlanTier): number {
  if (!tier) return DEFAULT_SHORT_FORM_BUDGET_PENCE;
  const scaled = Math.ceil(typicalCostPence(tier, 'short') * BUDGET_TYPICAL_VIDEO_MULTIPLE);
  return Math.max(DEFAULT_SHORT_FORM_BUDGET_PENCE, scaled, TIER_BUDGET_FLOOR_PENCE[tier].short);
}

/** 20.25: the long-form default for a tier (£30; PLUS / ENTERPRISE £45). */
export function longFormBudgetPence(tier?: PlanTier): number {
  if (!tier) return DEFAULT_LONG_FORM_BUDGET_PENCE;
  const scaled = Math.ceil(typicalCostPence(tier, 'long') * BUDGET_TYPICAL_VIDEO_MULTIPLE);
  return Math.max(DEFAULT_LONG_FORM_BUDGET_PENCE, scaled, TIER_BUDGET_FLOOR_PENCE[tier].long);
}

/** The per-project budget when the client sets none; `tier` = the organisation's plan tier. */
export function defaultProjectBudgetPence(
  formats: readonly BudgetFormat[],
  sourceType?: string,
  tier?: PlanTier,
): number {
  if (sourceType === 'SLIDESHOW') return DEFAULT_SLIDESHOW_BUDGET_PENCE;
  return isLongForm(formats) ? longFormBudgetPence(tier) : shortFormBudgetPence(tier);
}

/** Stored targetFormats JSON → BudgetFormat[] (malformed entries are ignored). */
export function budgetFormatsFromJson(value: unknown): BudgetFormat[] {
  if (!Array.isArray(value)) return [];
  const out: BudgetFormat[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const { platform, duration, durationSec } = item as Record<string, unknown>;
    if (typeof platform !== 'string') continue;
    out.push({
      platform,
      ...(typeof duration === 'number' && { duration }),
      ...(typeof durationSec === 'number' && { durationSec }),
    });
  }
  return out;
}
