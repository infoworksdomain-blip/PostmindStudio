import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORT_FORM_BUDGET_PENCE,
  DEFAULT_SLIDESHOW_BUDGET_PENCE,
} from '../cost/project-budget';
import {
  capItems,
  creditHeadroomPerItem,
  estimateCost,
  maxItemCostPence,
  typicalItemCostPence,
  type PlanAllowance,
  type PlanCost,
} from './allowance';
import type { PlanKind } from './mix';

const kinds = (n: number, kind: PlanKind = 'VIDEO') => Array.from({ length: n }, () => kind);
const enforce = (limit: number, used: number, credits = 0): PlanAllowance => ({
  mode: 'enforce',
  limit,
  used,
  credits,
  remaining: Math.max(0, limit - used) + credits,
});
const noCap: PlanCost = { capPence: null, spentPence: 0, creditHeadroomPence: 0 };

describe('20.9 plan allowance and cost', () => {
  it('uses the catalogue typical cost for videos and the budget cap for slideshows', () => {
    expect(typicalItemCostPence('VIDEO', 'STANDARD')).toBe(160);
    expect(typicalItemCostPence('VIDEO', 'ENTERPRISE')).toBe(240);
    expect(typicalItemCostPence('SLIDESHOW', 'BASIC')).toBe(DEFAULT_SLIDESHOW_BUDGET_PENCE);
    expect(maxItemCostPence('VIDEO')).toBe(DEFAULT_SHORT_FORM_BUDGET_PENCE);
    // 20.25 / 21.3: a video's "up to" is its tier's default project budget (STANDARD £5).
    expect(maxItemCostPence('VIDEO', 'STANDARD')).toBe(500);
    expect(estimateCost(['VIDEO', 'SLIDESHOW'], 'STANDARD')).toEqual({
      typicalPence: 160 + DEFAULT_SLIDESHOW_BUDGET_PENCE,
      maxPence: 500 + DEFAULT_SLIDESHOW_BUDGET_PENCE,
    });
  });

  it('knows the short top-up headroom per tier', () => {
    expect(creditHeadroomPerItem('BASIC')).toBe(100);
    expect(creditHeadroomPerItem('ENTERPRISE')).toBe(265);
  });

  it('takes everything when nothing limits it (warn mode, no cap)', () => {
    const warn: PlanAllowance = { mode: 'warn', limit: 20, used: 30, credits: 0, remaining: null };
    expect(capItems(kinds(60), 'BASIC', warn, noCap)).toEqual({ count: 60, cappedReason: null });
  });

  it('stops at the remaining allowance plus top-up credits', () => {
    expect(capItems(kinds(30), 'STANDARD', enforce(40, 25), noCap)).toEqual({
      count: 15,
      cappedReason: 'allowance',
    });
    expect(capItems(kinds(30), 'STANDARD', enforce(40, 25, 10), noCap)).toEqual({
      count: 25,
      cappedReason: 'allowance',
    });
    expect(capItems(kinds(10), 'STANDARD', enforce(40, 40), noCap).count).toBe(0);
  });

  it('stops where the typical cost would pass the monthly cap', () => {
    const cost: PlanCost = { capPence: 1_000, spentPence: 500, creditHeadroomPence: 175 };
    // 500p left at 160p a video: 3 fit.
    expect(capItems(kinds(10), 'STANDARD', enforce(40, 0), cost)).toEqual({
      count: 3,
      cappedReason: 'cost_cap',
    });
  });

  it('counts the cap headroom each top-up credit adds', () => {
    // Plan allowance used up; 5 credits. Each credit adds 175p headroom, a video costs 160p.
    const cost: PlanCost = { capPence: 7_300, spentPence: 7_300, creditHeadroomPence: 175 };
    expect(capItems(kinds(5), 'STANDARD', enforce(40, 40, 5), cost)).toEqual({
      count: 5,
      cappedReason: null,
    });
  });
});
