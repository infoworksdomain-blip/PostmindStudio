import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// BACKLOG 15.D10 — A14.2 "Cost regression: each project mode's actual provider cost within 15%
// of the estimates in A10". A10.1 gives a per-output range per project mode (quoted below, in
// pence). A mode passes when its median actual cost lies inside [low × 0.85, high × 1.15].
//
// "Actual" means what staging really spent (video_projects.costActualPence), exported by the
// operator with the SQL in runbooks/slo-and-launch-readiness.md into
// test/cost/fixtures/a10-actuals.json (or A10_ACTUALS_PATH). The offline harness journeys
// (journeys.ts) are estimates, not actuals, so they are never used to claim this gate passes.

export const A10_TOLERANCE = 0.15;

/** A10.1 "Provider cost per output" (GBP → pence). */
export const A10_BANDS = {
  standard_short: {
    low: 81,
    high: 115,
    source: 'Standard AI short (unchanged v1.0) £0.81 – £1.15',
  },
  inspire: { low: 85, high: 120, source: 'Library-referenced (INSPIRE mode) £0.85 – £1.20' },
  template: { low: 90, high: 125, source: 'Library-referenced (TEMPLATE mode) £0.90 – £1.25' },
  slideshow: { low: 41, high: 64, source: 'Slideshow (Feature C) £0.41 – £0.64' },
  long_form_6min: {
    low: 702,
    high: 992,
    source: 'Long-form 6-minute (unchanged v1.0) £7.02 – £9.92',
  },
} as const;
export type A10Mode = keyof typeof A10_BANDS;

/** A10.1 increments over the standard short (INSPIRE +£0.04–0.05, TEMPLATE +£0.09–0.10). */
export const A10_INCREMENT_PENCE: Record<'inspire' | 'template', { low: number; high: number }> = {
  inspire: { low: 4, high: 5 },
  template: { low: 9, high: 10 },
};

export interface A10Verdict {
  mode: A10Mode;
  actualPence: number;
  minPence: number;
  maxPence: number;
  pass: boolean;
}

export function a10Verdict(mode: A10Mode, actualPence: number): A10Verdict {
  const band = A10_BANDS[mode];
  const minPence = Math.round(band.low * (1 - A10_TOLERANCE) * 100) / 100;
  const maxPence = Math.round(band.high * (1 + A10_TOLERANCE) * 100) / 100;
  return {
    mode,
    actualPence,
    minPence,
    maxPence,
    pass: actualPence >= minPence && actualPence <= maxPence,
  };
}

export function median(values: number[]): number {
  if (values.length === 0) throw new RangeError('median of an empty list');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * The A10 mode of a staging project from its own fields, or null when it matches none of the
 * A10 sample shapes (e.g. a 90 s short or a 3-format project: A10 prices one output).
 */
export function a10ModeOf(project: {
  sourceType: string;
  referenceMode: string | null;
  formatCount: number;
  maxDurationSec: number;
}): A10Mode | null {
  if (project.formatCount !== 1) return null;
  if (project.sourceType === 'SLIDESHOW') return 'slideshow';
  if (project.maxDurationSec >= 300 && project.maxDurationSec <= 420) return 'long_form_6min';
  if (project.maxDurationSec < 20 || project.maxDurationSec > 45) return null;
  if (project.sourceType === 'LIBRARY_REFERENCE') {
    if (project.referenceMode === 'INSPIRE') return 'inspire';
    if (project.referenceMode === 'TEMPLATE') return 'template';
    return null;
  }
  return project.sourceType === 'BRIEF' ? 'standard_short' : null;
}

export const a10ActualsSchema = z.object({
  capturedAt: z.string().min(1),
  environment: z.string().min(1),
  projects: z
    .array(
      z.object({
        id: z.string().min(1),
        sourceType: z.string().min(1),
        referenceMode: z.string().nullable(),
        formatCount: z.number().int().min(0),
        maxDurationSec: z.number().min(0),
        costActualPence: z.number().int().min(0),
      }),
    )
    .min(1),
});
export type A10Actuals = z.infer<typeof a10ActualsSchema>;

/** The operator's staging export, or null when it has not been captured yet. */
export function loadA10Actuals(
  env: Record<string, string | undefined> = process.env,
): A10Actuals | null {
  const path =
    env.A10_ACTUALS_PATH?.trim() ||
    fileURLToPath(new URL('./fixtures/a10-actuals.json', import.meta.url));
  if (!existsSync(path)) return null;
  return a10ActualsSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** Median actual cost per A10 mode, with the verdict for each mode that has projects. */
export function a10Report(actuals: A10Actuals): Array<A10Verdict & { projects: number }> {
  const byMode = new Map<A10Mode, number[]>();
  for (const p of actuals.projects) {
    const mode = a10ModeOf(p);
    if (!mode) continue;
    byMode.set(mode, [...(byMode.get(mode) ?? []), p.costActualPence]);
  }
  return [...byMode.entries()].map(([mode, costs]) => ({
    ...a10Verdict(mode, median(costs)),
    projects: costs.length,
  }));
}
