import { describe, expect, it } from 'vitest';
import {
  A10_BANDS,
  A10_INCREMENT_PENCE,
  a10ModeOf,
  a10Report,
  a10Verdict,
  loadA10Actuals,
  median,
  type A10Actuals,
} from './a10';
import { journeyCosts } from './journeys';

// BACKLOG 15.D10 — A14.2 cost regression per project mode against A10 (±15%).

describe('a10Verdict', () => {
  it('passes inside the A10 range widened by 15% and fails outside it', () => {
    // standard short £0.81–£1.15 → 68.85p … 132.25p
    expect(a10Verdict('standard_short', 69).pass).toBe(true);
    expect(a10Verdict('standard_short', 132).pass).toBe(true);
    expect(a10Verdict('standard_short', 68).pass).toBe(false);
    expect(a10Verdict('standard_short', 133)).toMatchObject({
      pass: false,
      minPence: 68.85,
      maxPence: 132.25,
    });
    expect(a10Verdict('long_form_6min', 800).pass).toBe(true);
  });
});

describe('a10ModeOf', () => {
  const one = { formatCount: 1, maxDurationSec: 30, referenceMode: null };
  it('maps single-output projects to their A10 mode', () => {
    expect(a10ModeOf({ ...one, sourceType: 'BRIEF' })).toBe('standard_short');
    expect(a10ModeOf({ ...one, sourceType: 'LIBRARY_REFERENCE', referenceMode: 'INSPIRE' })).toBe(
      'inspire',
    );
    expect(a10ModeOf({ ...one, sourceType: 'LIBRARY_REFERENCE', referenceMode: 'TEMPLATE' })).toBe(
      'template',
    );
    expect(a10ModeOf({ ...one, sourceType: 'SLIDESHOW' })).toBe('slideshow');
    expect(a10ModeOf({ ...one, sourceType: 'BRIEF', maxDurationSec: 360 })).toBe('long_form_6min');
  });
  it('ignores shapes A10 does not price', () => {
    expect(a10ModeOf({ ...one, sourceType: 'BRIEF', formatCount: 3 })).toBeNull();
    expect(a10ModeOf({ ...one, sourceType: 'BRIEF', maxDurationSec: 90 })).toBeNull();
    expect(a10ModeOf({ ...one, sourceType: 'UPLOAD' })).toBeNull();
    expect(a10ModeOf({ ...one, sourceType: 'LIBRARY_REFERENCE' })).toBeNull();
  });
});

describe('a10Report', () => {
  it('takes the median actual cost per mode', () => {
    const actuals: A10Actuals = {
      capturedAt: '2026-10-01',
      environment: 'test',
      projects: [100, 110, 400].map((cost, i) => ({
        id: `p${i}`,
        sourceType: 'BRIEF',
        referenceMode: null,
        formatCount: 1,
        maxDurationSec: 30,
        costActualPence: cost,
      })),
    };
    expect(a10Report(actuals)).toEqual([
      {
        mode: 'standard_short',
        actualPence: 110,
        minPence: 68.85,
        maxPence: 132.25,
        pass: true,
        projects: 3,
      },
    ]);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(() => median([])).toThrow(RangeError);
  });
});

describe('harness journeys vs A10 (estimates, offline)', () => {
  const cost = journeyCosts();

  // A10.1 adds £0.04–0.05 (INSPIRE) and £0.09–0.10 (TEMPLATE) to a standard short. Studio's
  // reference modes add one query embedding and a prompt supplement; the harness asserts that
  // the increment stays within A10's upper bound + 15%.
  it.each(['inspire', 'template'] as const)(
    '%s adds no more than A10 says over the standard short',
    (mode) => {
      const delta = (cost[`${mode}-30s-short`] ?? NaN) - (cost['standard-30s-short'] ?? NaN);
      expect(delta).toBeGreaterThanOrEqual(0);
      expect(delta).toBeLessThanOrEqual(A10_INCREMENT_PENCE[mode].high * 1.15);
    },
  );

  // Not asserted: the harness prices a 30 s short at the adapters' list prices (three 10 s
  // Runway clips alone exceed A10's whole £0.81–£1.15), so the absolute gate is decided on
  // staging actuals only (below). Recorded here so the gap is visible in the test output.
  it('documents the harness estimate for the standard short beside the A10 band', () => {
    expect(A10_BANDS.standard_short.high).toBe(115);
    expect(cost['standard-30s-short']).toBeGreaterThan(0);
  });
});

const actuals = loadA10Actuals();

describe.skipIf(!actuals)(
  'A14.2 gate: staging actual cost per mode within 15% of A10 (operator export)',
  () => {
    it('every mode with staging projects is inside its A10 band ± 15%', () => {
      const report = a10Report(actuals as A10Actuals);
      expect(report.length).toBeGreaterThan(0);
      expect(report.filter((r) => !r.pass)).toEqual([]);
    });
  },
);
