import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { costDrift, journeyCosts, JOURNEYS } from './journeys';

// BACKLOG 13.31 / spec 17.5 — weekly cost regression (.github/workflows/cost-regression.yml, and
// every CI run). Fails when any golden journey's cost moves more than 10 % from the committed
// baseline. After an intended price or pipeline change, update cost-baseline.json in the same PR
// (runbooks/cost-runaway.md "Cost regression").

const MAX_DRIFT = 0.1;

const baseline = JSON.parse(
  readFileSync(fileURLToPath(new URL('./cost-baseline.json', import.meta.url)), 'utf8'),
) as { journeysPence: Record<string, number> };

describe('cost regression: golden journeys at harness prices', () => {
  const actual = journeyCosts();

  it('prices every journey with a positive total', () => {
    for (const name of Object.keys(JOURNEYS)) expect(actual[name]).toBeGreaterThan(0);
  });

  it(`stays within ${MAX_DRIFT * 100}% of the committed baseline`, () => {
    const drifted = costDrift(baseline.journeysPence, actual).filter((d) => d.drift > MAX_DRIFT);
    expect(
      drifted,
      `update test/cost/cost-baseline.json if intended: ${JSON.stringify(actual)}`,
    ).toEqual([]);
  });
});

describe('costDrift', () => {
  it('reports relative drift and treats missing journeys as infinite drift', () => {
    expect(costDrift({ a: 100, b: 10 }, { a: 111, c: 5 })).toEqual([
      { journey: 'a', baseline: 100, actual: 111, drift: 0.11 },
      { journey: 'b', baseline: 10, actual: null, drift: Infinity },
      { journey: 'c', baseline: null, actual: 5, drift: Infinity },
    ]);
    expect(costDrift({ z: 0 }, { z: 0 })[0]?.drift).toBe(0);
    expect(costDrift({ z: 0 }, { z: 1 })[0]?.drift).toBe(Infinity);
  });
});
