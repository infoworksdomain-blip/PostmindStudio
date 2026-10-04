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
    // 21.5: STANDARD at Seedance 2.0 full, 720p (~241p a short).
    expect(typicalItemCostPence('VIDEO', 'STANDARD')).toBe(241);
    expect(typicalItemCostPence('VIDEO', 'ENTERPRISE')).toBe(240);
    expect(typicalItemCostPence('SLIDESHOW', 'BASIC')).toBe(DEFAULT_SLIDESHOW_BUDGET_PENCE);
    expect(maxItemCostPence('VIDEO')).toBe(DEFAULT_SHORT_FORM_BUDGET_PENCE);
    // 20.25: a video's "up to" is its tier's default project budget (STANDARD £4).
    expect(maxItemCostPence('VIDEO', 'STANDARD')).toBe(400);
    expect(estimateCost(['VIDEO', 'SLIDESHOW'], 'STANDARD')).toEqual({
      typicalPence: 241 + DEFAULT_SLIDESHOW_BUDGET_PENCE,
      maxPence: 400 + DEFAULT_SLIDESHOW_BUDGET_PENCE,
    });
  });

  it('knows the video-pack headroom per item (21.5: the same on every plan)', () => {
    expect(creditHeadroomPerItem('BASIC')).toBe(250);
    expect(creditHeadroomPerItem('STANDARD')).toBe(250);
    expect(creditHeadroomPerItem()).toBe(250);
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
    const cost: PlanCost = { capPence: 1_000, spentPence: 500, creditHeadroomPence: 250 };
    // 500p left at 241p a video: 2 fit.
    expect(capItems(kinds(10), 'STANDARD', enforce(40, 0), cost)).toEqual({
      count: 2,
      cappedReason: 'cost_cap',
    });
  });

  it('counts the cap headroom each top-up credit adds', () => {
    // Plan allowance used up; 5 credits. Each credit adds 250p headroom, a video costs 241p.
    const cost: PlanCost = { capPence: 7_300, spentPence: 7_300, creditHeadroomPence: 250 };
    expect(capItems(kinds(5), 'STANDARD', enforce(40, 40, 5), cost)).toEqual({
      count: 5,
      cappedReason: null,
    });
  });
});
