import { TAIL_SEC, fittedShotSec } from './voice-fit';

// BACKLOG 21.1 — rebalance time within a script before any narration is trimmed.
//
// Voice fit (voice-fit.ts) works one shot at a time while the shots are still being generated, so
// when a line is longer than its shot and the script has no head-room left, its last resort is to
// cut the narration (production QA run 8: "…like you've had hours to" lost "prep."). Once every
// shot of the run is measured (the start of composition), this pure function looks at the whole
// script: a trimmed shot whose picture can play longer is lengthened to hold its narration, and
// the time is taken back from shots with slack, so the script's total length — and therefore the
// ±2 s duration check — does not move. Only when donors cannot cover it is the script's own
// head-room (the same budget voice-fit's "extend" step uses) spent.
//
// Who may lengthen (receivers): a shot whose narration was trimmed and whose picture can play
// for the new length: stills, text and motion cards always (maxVisualSec = Infinity); a video
// shot (AI clip, avatar, stock, upload) only when its stored clip really runs that long — the
// composer cuts a longer clip to the shot length, so a 5 s provider clip in a 2.5 s shot can
// simply play longer.
// Who gives time (donors): any other shot that may change length, down to the longest of
//   - MIN_DISPLAY_SEC (why below);
//   - its own narration + TAIL_SEC (never trims the donor's words);
//   - the end of any overlay that ends before the shot does (overlays never lose words), and the
//     start + MIN_DISPLAY_SEC of an overlay that runs to the shot end (it follows the new end);
//   - for a shot without narration, the time to read its on-screen text (READING_WORDS_PER_SEC).
// Donors nearest the trimmed shot give first (the following shot before the preceding one at the
// same distance), so the edit's rhythm changes locally. A shot is only lengthened when the whole
// shortfall is found; a partial lengthening would still cut the sentence. All arithmetic is in
// centiseconds, so the total is preserved exactly.

/**
 * The shortest a shot may become when it gives time away. 1.2 s: short-form edits cut every
 * 1.5–3 s, and below roughly a second a still or card reads as a flash rather than a shot; 1.2 s
 * also stays above the scriptwriter's own 1 s minimum (scripting.ts shotDurationBounds), so
 * rebalancing never makes a shot shorter than a script could have planned it.
 */
export const MIN_DISPLAY_SEC = 1.2;
/**
 * On-screen reading pace for a shot without narration: 3 words/s (180 wpm), below adult silent
 * reading (~200–250 wpm) because the text sits over moving pictures and is read at a glance.
 */
export const READING_WORDS_PER_SEC = 3;

export interface RebalanceShot {
  id: string;
  durationSec: number;
  /** How long the shot's narration speaks (voice-fit voiceSec); null = no narration. */
  voiceSec: number | null;
  /** The narration overran and is (provisionally) trimmed: a candidate to lengthen. */
  trimmed: boolean;
  /** The shot has narration that could not be measured: it is left exactly as it is. */
  unmeasured: boolean;
  /**
   * Longest the picture can play: Infinity for stills and cards, the stored clip's real length
   * for video, null when unknown (the shot cannot lengthen).
   */
  maxVisualSec: number | null;
  /** The shot may give time away (false e.g. for an uploaded clip playing its own sound). */
  canDonate: boolean;
  /** Seconds the shot must keep for its overlays (see the donor rules above). */
  overlayHoldSec: number;
  /** Words of on-screen text a viewer reads on this shot (cards, captions). */
  readingWords: number;
}

export interface RebalanceDonation {
  shotId: string;
  sec: number;
}

export interface RebalanceLengthened {
  shotId: string;
  fromSec: number;
  toSec: number;
  donors: RebalanceDonation[];
  /** Seconds taken from the script's head-room rather than from other shots. */
  budgetSec: number;
}

export interface RebalancePlan {
  /** New length of every shot whose length changed. */
  durations: Record<string, number>;
  lengthened: RebalanceLengthened[];
  /** Trimmed shots that could not be given enough time (they stay trimmed). */
  unresolved: string[];
  /** Head-room spent in total. */
  budgetUsedSec: number;
}

const toSec = (cs: number) => cs / 100;
const roundMs = (sec: number) => Math.round(sec * 1000) / 1000;

/** The shortest the shot may become as a donor. */
export function donorFloorSec(shot: RebalanceShot): number {
  const narration = shot.voiceSec !== null ? shot.voiceSec + TAIL_SEC : 0;
  const reading = shot.voiceSec === null ? shot.readingWords / READING_WORDS_PER_SEC : 0;
  return Math.max(MIN_DISPLAY_SEC, narration, reading, shot.overlayHoldSec);
}

/** Centiseconds the shot can give away (0 when it may not donate). */
function slackCs(shot: RebalanceShot): number {
  if (!shot.canDonate || shot.trimmed || shot.unmeasured) return 0;
  return Math.max(0, Math.floor((shot.durationSec - donorFloorSec(shot)) * 100 + 1e-6));
}

/** The length a trimmed shot needs, or null when it cannot lengthen to it. */
function targetSec(shot: RebalanceShot): number | null {
  if (!shot.trimmed || shot.unmeasured || shot.voiceSec === null) return null;
  const needed = fittedShotSec(shot.voiceSec);
  if (needed <= shot.durationSec) return null;
  if (shot.maxVisualSec === null || needed > shot.maxVisualSec + 1e-6) return null;
  return needed;
}

/** Donor indexes nearest `at` first; at equal distance the following shot first. */
function donorOrder(count: number, at: number): number[] {
  return Array.from({ length: count }, (_, i) => i)
    .filter((i) => i !== at)
    .sort((a, b) => Math.abs(a - at) - Math.abs(b - at) || b - a);
}

/**
 * Plan new shot lengths so trimmed narration is heard whole. Deterministic and pure: the same
 * shots and budget always give the same plan; shots are visited in script order.
 */
export function rebalanceShots(
  shots: readonly RebalanceShot[],
  options: { budgetSec: number },
): RebalancePlan {
  const slack = shots.map(slackCs);
  const deltaCs = shots.map(() => 0);
  let budgetCs = Math.max(0, Math.floor(options.budgetSec * 100 + 1e-6));
  let budgetUsedCs = 0;
  const lengthened: RebalanceLengthened[] = [];
  const unresolved: string[] = [];

  shots.forEach((shot, at) => {
    if (!shot.trimmed) return;
    const target = targetSec(shot);
    if (target === null) {
      unresolved.push(shot.id);
      return;
    }
    const needCs = Math.ceil((target - shot.durationSec) * 100 - 1e-6);
    const takes: Array<{ index: number; cs: number }> = [];
    let found = 0;
    for (const index of donorOrder(shots.length, at)) {
      if (found >= needCs) break;
      const cs = Math.min(slack[index] ?? 0, needCs - found);
      if (cs > 0) {
        takes.push({ index, cs });
        found += cs;
      }
    }
    const fromBudget = Math.min(budgetCs, needCs - found);
    if (found + fromBudget < needCs) {
      unresolved.push(shot.id);
      return;
    }
    for (const take of takes) {
      slack[take.index] = (slack[take.index] ?? 0) - take.cs;
      deltaCs[take.index] = (deltaCs[take.index] ?? 0) - take.cs;
    }
    budgetCs -= fromBudget;
    budgetUsedCs += fromBudget;
    deltaCs[at] = (deltaCs[at] ?? 0) + needCs;
    lengthened.push({
      shotId: shot.id,
      fromSec: shot.durationSec,
      toSec: roundMs(shot.durationSec + toSec(needCs)),
      donors: takes.map((t) => ({ shotId: shots[t.index]?.id ?? '', sec: toSec(t.cs) })),
      budgetSec: toSec(fromBudget),
    });
  });

  const durations: Record<string, number> = {};
  shots.forEach((shot, i) => {
    const delta = deltaCs[i] ?? 0;
    if (delta !== 0) durations[shot.id] = roundMs(shot.durationSec + toSec(delta));
  });
  return { durations, lengthened, unresolved, budgetUsedSec: toSec(budgetUsedCs) };
}
