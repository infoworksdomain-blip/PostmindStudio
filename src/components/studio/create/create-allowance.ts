import {
  isQuickPostSourceType,
  QUICK_POST_QUARTERS,
  quartersToVideos,
  VIDEO_QUARTERS,
} from '@/lib/studio/billing/allowance-units';
import { UGC_VIDEO_QUARTERS } from '@/lib/studio/ugc/allowance';
import type { UsageResponse } from '../usage-meter';
import type { CreateSource, CreateState } from './body';
import { buildFormats } from './formats';

// BACKLOG 25.7 — the live allowance line on Create: what this post uses (23.3 quarters of a video:
// a quick post ¼, an AI or uploaded video 1, a UGC actor video 2 — ugc/allowance.ts
// allowanceQuartersOf, the rule the server counts with) and what is left in the plan's window
// (GET /usage). The server stays the authority; this only reads the same numbers.

/** Quarters of a video one generation of this format uses. */
export function formatQuarters(source: CreateSource): number {
  if (source === 'UGC') return UGC_VIDEO_QUARTERS;
  return isQuickPostSourceType(source) ? QUICK_POST_QUARTERS : VIDEO_QUARTERS;
}

/** plan-quotas.ts videoKind: slideshows and carousels are short; else the longest format. */
export function allowanceKind(
  state: Pick<CreateState, 'source' | 'platforms' | 'length' | 'projectTemplate'>,
  shortMaxSec: number | null,
): 'short' | 'long' {
  if (state.source === 'SLIDESHOW' || state.source === 'CAROUSEL') return 'short';
  // A template's formats are only known server-side: count it as short (its usual case).
  if (state.projectTemplate || shortMaxSec === null) return 'short';
  const longest = Math.max(
    0,
    ...buildFormats(state.platforms, state.length).map((f) => f.durationSec),
  );
  return longest > shortMaxSec ? 'long' : 'short';
}

export interface AllowanceLine {
  /** Videos this post uses (0.25, 1, 2). */
  usesVideos: number;
  /** Videos left in the window after earlier use; null = unlimited or unknown. */
  leftVideos: number | null;
  limitVideos: number | null;
  period: 'week' | 'month';
}

export function allowanceLine(
  state: Pick<CreateState, 'source' | 'platforms' | 'length' | 'projectTemplate'>,
  usage: UsageResponse['usage'] | undefined,
): AllowanceLine {
  const usesVideos = quartersToVideos(formatQuarters(state.source));
  const short = usage?.videos?.short;
  const meter = usage?.videos?.[allowanceKind(state, short?.maxDurationSec ?? null)];
  const period = usage?.period === 'week' ? 'week' : 'month';
  // An allowance of 0 (long videos on a per-channel plan) is hidden in the customer UI (21.5).
  if (!meter || !meter.limitQuarters || meter.usedQuarters == null)
    return { usesVideos, leftVideos: null, limitVideos: null, period };
  return {
    usesVideos,
    leftVideos: quartersToVideos(Math.max(0, meter.limitQuarters - meter.usedQuarters)),
    limitVideos: quartersToVideos(meter.limitQuarters),
    period,
  };
}
