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

export const DEFAULT_SHORT_FORM_BUDGET_PENCE = 350;
export const DEFAULT_LONG_FORM_BUDGET_PENCE = 3_000;
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

export function defaultProjectBudgetPence(formats: readonly BudgetFormat[]): number {
  return isLongForm(formats) ? DEFAULT_LONG_FORM_BUDGET_PENCE : DEFAULT_SHORT_FORM_BUDGET_PENCE;
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
