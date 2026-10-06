import { FORMATS, type FormatKey } from './formats';
import { effectiveFormatWeight, type MixPreferences } from './mix';

// 22.5 — which format each automation slot gets, at the lowest cost: the business's weights
// share the slots out (largest remainder, spread evenly through the period rather than in
// blocks), and when the allowance, the cost cap or the period's ceiling cannot cover every slot
// the MOST EXPENSIVE ones are dropped first (cheapest first: carousels, slideshows, then any paid
// format the owner switched on). Pure and deterministic.

/** Units of the allowance a format uses when it is generated (ugc/allowance.ts: UGC = 2). */
export function allowanceUnitsFor(format: FormatKey): number {
  return format === 'ugc' ? 2 : 1;
}

/** Slot counts per format by weight (largest remainder; ties to the cheaper format). */
export function shareSlots(
  count: number,
  weights: ReadonlyArray<readonly [FormatKey, number]>,
): Map<FormatKey, number> {
  const live = weights.filter(([, w]) => w > 0);
  const total = live.reduce((sum, [, w]) => sum + w, 0);
  const out = new Map<FormatKey, number>();
  if (count <= 0 || total <= 0) return out;
  const exact = live.map(([key, w]) => ({ key, value: (count * w) / total }));
  let given = 0;
  for (const e of exact) {
    const n = Math.floor(e.value);
    out.set(e.key, n);
    given += n;
  }
  const byRemainder = [...exact].sort(
    (a, b) =>
      b.value - Math.floor(b.value) - (a.value - Math.floor(a.value)) ||
      FORMATS[a.key].costRank - FORMATS[b.key].costRank,
  );
  for (const e of byRemainder) {
    if (given >= count) break;
    out.set(e.key, (out.get(e.key) ?? 0) + 1);
    given += 1;
  }
  return out;
}

/**
 * One format per slot: the shares spread through the slots (each format's posts evenly spaced,
 * so a month is not all carousels then all slideshows).
 */
export function allocateFormats(
  count: number,
  prefs: MixPreferences,
  allowed: readonly FormatKey[],
): FormatKey[] {
  const shares = shareSlots(
    count,
    allowed.map((key) => [key, effectiveFormatWeight(prefs, key)] as const),
  );
  // Each post gets an ideal position (k + 0.5) / n of the way through the period; sort by it.
  const placed: Array<{ key: FormatKey; at: number }> = [];
  for (const [key, n] of shares)
    for (let k = 0; k < n; k += 1) placed.push({ key, at: (k + 0.5) / n });
  placed.sort((a, b) => a.at - b.at || FORMATS[a.key].costRank - FORMATS[b.key].costRank);
  return placed.map((p) => p.key);
}

/**
 * The slot indexes that fit `units` of allowance (and the optional pence ceiling at each
 * format's typical cost): the cheapest formats are kept first; ties keep the earlier slot.
 * Returns the kept indexes in slot order.
 */
export function keepCheapestFirst(
  formats: readonly FormatKey[],
  units: number | null,
  options: { ceilingPence?: number | null; typicalPence?: (format: FormatKey) => number } = {},
): number[] {
  const order = formats
    .map((format, index) => ({ format, index }))
    .sort((a, b) => FORMATS[a.format].costRank - FORMATS[b.format].costRank || a.index - b.index);
  let unitsLeft = units ?? Infinity;
  let pence = 0;
  const kept: number[] = [];
  for (const { format, index } of order) {
    const need = allowanceUnitsFor(format);
    if (need > unitsLeft) continue;
    const cost = options.typicalPence?.(format) ?? 0;
    if (options.ceilingPence != null && pence + cost > options.ceilingPence) continue;
    unitsLeft -= need;
    pence += cost;
    kept.push(index);
  }
  return kept.sort((a, b) => a - b);
}
