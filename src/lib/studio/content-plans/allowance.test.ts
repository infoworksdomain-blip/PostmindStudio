import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORT_FORM_BUDGET_PENCE,
  DEFAULT_SLIDESHOW_BUDGET_PENCE,
} from '../cost/project-budget';
import {
  capItems,
  capItemsOf,
  creditHeadroomPerItem,
  planItemQuarters,
  estimateCost,
  maxItemCostPence,
  TYPICAL_FORMAT_COST_PENCE,
  typicalFormatCostPence,
  typicalItemCostPence,
  type CapItem,
  type PlanAllowance,
  type PlanCost,
} from './allowance';
import type { FormatKey } from '../blitz/formats';
import type { PlanKind } from './mix';

const kinds = (n: number, kind: PlanKind = 'VIDEO') =>
  capItemsOf(Array.from({ length: n }, () => kind));
/** Limit, used and credits in videos (23.3: quarter numbers allowed). */
const enforce = (limit: number, used: number, credits = 0): PlanAllowance => ({
  mode: 'enforce',
  limit,
  used,
  credits,
  remaining: Math.max(0, limit - used) + credits,
  quarters: {
    limit: limit * 4,
    used: used * 4,
    credits: credits * 4,
    remaining: (Math.max(0, limit - used) + credits) * 4,
  },
});
const noCap: PlanCost = { capPence: null, spentPence: 0, creditHeadroomPence: 0 };

describe('20.9 plan allowance and cost', () => {
  it('uses the catalogue typical cost for videos and the measured cost for slideshows', () => {
    // 21.5: STANDARD at Seedance 2.0 full, 720p (~241p a short).
    expect(typicalItemCostPence('VIDEO', 'STANDARD')).toBe(241);
    expect(typicalItemCostPence('VIDEO', 'ENTERPRISE')).toBe(240);
    // 23.4: a slideshow typically costs ~30p; its "up to" stays the slideshow budget cap.
    expect(typicalItemCostPence('SLIDESHOW', 'BASIC')).toBe(30);
    expect(typicalItemCostPence('CAROUSEL', 'BASIC')).toBe(5);
    expect(maxItemCostPence('SLIDESHOW')).toBe(DEFAULT_SLIDESHOW_BUDGET_PENCE);
    expect(maxItemCostPence('VIDEO')).toBe(DEFAULT_SHORT_FORM_BUDGET_PENCE);
    // 20.25 / 21.3: a video's "up to" is its tier's default project budget (STANDARD £5).
    expect(maxItemCostPence('VIDEO', 'STANDARD')).toBe(500);
    expect(estimateCost(['VIDEO', 'SLIDESHOW'], 'STANDARD')).toEqual({
      typicalPence: 241 + 30,
      maxPence: 500 + DEFAULT_SLIDESHOW_BUDGET_PENCE,
    });
  });

  it('knows the video-pack headroom per item (21.5: the same on every plan)', () => {
    expect(creditHeadroomPerItem('BASIC')).toBe(250);
    expect(creditHeadroomPerItem('STANDARD')).toBe(250);
    expect(creditHeadroomPerItem()).toBe(250);
  });

  it('takes everything when nothing limits it (warn mode, no cap)', () => {
    const warn: PlanAllowance = {
      mode: 'warn',
      limit: 20,
      used: 30,
      credits: 0,
      remaining: null,
      quarters: { limit: 80, used: 120, credits: 0, remaining: null },
    };
    expect(capItems(kinds(60), 'BASIC', warn, noCap)).toEqual({
      count: 60,
      quarters: 240,
      cappedReason: null,
    });
  });

  it('stops at the remaining allowance plus top-up credits', () => {
    expect(capItems(kinds(30), 'STANDARD', enforce(40, 25), noCap)).toEqual({
      count: 15,
      quarters: 60,
      cappedReason: 'allowance',
    });
    expect(capItems(kinds(30), 'STANDARD', enforce(40, 25, 10), noCap)).toEqual({
      count: 25,
      quarters: 100,
      cappedReason: 'allowance',
    });
    expect(capItems(kinds(10), 'STANDARD', enforce(40, 40), noCap).count).toBe(0);
  });

  it('stops where the typical cost would pass the monthly cap', () => {
    const cost: PlanCost = { capPence: 1_000, spentPence: 500, creditHeadroomPence: 250 };
    // 500p left at 241p a video: 2 fit.
    expect(capItems(kinds(10), 'STANDARD', enforce(40, 0), cost)).toEqual({
      count: 2,
      quarters: 8,
      cappedReason: 'cost_cap',
    });
  });

  it('counts the cap headroom each top-up credit adds', () => {
    // Plan allowance used up; 5 credits. Each credit adds 250p headroom, a video costs 241p.
    const cost: PlanCost = { capPence: 7_300, spentPence: 7_300, creditHeadroomPence: 250 };
    expect(capItems(kinds(5), 'STANDARD', enforce(40, 40, 5), cost)).toEqual({
      count: 5,
      quarters: 20,
      cappedReason: null,
    });
  });
});

describe('23.4 per-format typical costs', () => {
  it('prices each format at its measured typical cost (production 2026-10-06)', () => {
    expect(typicalFormatCostPence('carousel', 'STANDARD')).toBe(5);
    expect(typicalFormatCostPence('wall_of_text', 'STANDARD')).toBe(15);
    expect(typicalFormatCostPence('slideshow', 'STANDARD')).toBe(30);
    expect(typicalFormatCostPence('hook_demo', 'STANDARD')).toBe(50);
    // AI video and UGC keep the catalogue's typical cost per short video.
    expect(typicalFormatCostPence('ai_video', 'STANDARD')).toBe(241);
    expect(typicalFormatCostPence('ugc', 'STANDARD')).toBe(241);
    // A format beats the kind: a wall of text is a VIDEO item but costs ~15p.
    expect(typicalItemCostPence('VIDEO', 'STANDARD', 'wall_of_text')).toBe(15);
    expect(typicalItemCostPence('VIDEO', 'STANDARD', null)).toBe(241);
    expect(TYPICAL_FORMAT_COST_PENCE.carousel).toBeLessThan(TYPICAL_FORMAT_COST_PENCE.hook_demo);
  });

  it('keeps a cheap 84-post month under a £100 cap with £36 spent (was cut to cost_cap)', () => {
    const cost: PlanCost = { capPence: 10_000, spentPence: 3_600, creditHeadroomPence: 250 };
    const unlimited: PlanAllowance = {
      mode: 'warn',
      limit: null,
      used: 0,
      credits: 0,
      remaining: null,
      quarters: { limit: null, used: 0, credits: 0, remaining: null },
    };
    const formats: FormatKey[] = [
      ...Array<FormatKey>(30).fill('carousel'),
      ...Array<FormatKey>(30).fill('slideshow'),
      ...Array<FormatKey>(12).fill('wall_of_text'),
      ...Array<FormatKey>(12).fill('hook_demo'),
    ];
    const items: CapItem[] = formats.map((format) => ({
      kind: format === 'carousel' ? 'CAROUSEL' : format === 'slideshow' ? 'SLIDESHOW' : 'VIDEO',
      quarters: 1,
      format,
    }));
    expect(capItems(items, 'STANDARD', unlimited, cost)).toEqual({
      count: 84,
      quarters: 84,
      cappedReason: null,
    });
    // Without formats (the old per-kind pricing) the same month was cut short.
    const byKind = items.map(({ kind, quarters }) => ({ kind, quarters }));
    expect(capItems(byKind, 'STANDARD', unlimited, cost).cappedReason).toBe('cost_cap');
  });

  it('still enforces the cap at the format costs', () => {
    // 100p left: 20 carousels at 5p fit, the 21st does not.
    const cost: PlanCost = { capPence: 1_100, spentPence: 1_000, creditHeadroomPence: 0 };
    const items: CapItem[] = Array.from({ length: 30 }, () => ({
      kind: 'CAROUSEL',
      quarters: 1,
      format: 'carousel',
    }));
    expect(capItems(items, 'STANDARD', enforce(40, 0), cost)).toEqual({
      count: 20,
      quarters: 20,
      cappedReason: 'cost_cap',
    });
  });
});

describe('23.3 quick posts count as a quarter of a video', () => {
  it('counts slideshows and carousels as 1 quarter, videos 4, UGC videos 8', () => {
    expect(planItemQuarters('SLIDESHOW')).toBe(1);
    expect(planItemQuarters('CAROUSEL')).toBe(1);
    expect(planItemQuarters('VIDEO')).toBe(4);
    expect(planItemQuarters('VIDEO', true)).toBe(8);
  });

  it("fits 32 carousels in one channel's 8 videos, but only 8 AI videos", () => {
    expect(capItems(kinds(40, 'CAROUSEL'), 'STANDARD', enforce(8, 0), noCap)).toEqual({
      count: 32,
      quarters: 32,
      cappedReason: 'allowance',
    });
    expect(capItems(kinds(40), 'STANDARD', enforce(8, 0), noCap).count).toBe(8);
  });

  it('stops at the first item that does not fit in what is left (mixed kinds)', () => {
    // 7.75 videos used: one quarter left: a slideshow fits, the video after it does not.
    const items = capItemsOf(['SLIDESHOW', 'VIDEO', 'SLIDESHOW']);
    expect(capItems(items, 'STANDARD', enforce(8, 7.75), noCap)).toEqual({
      count: 1,
      quarters: 1,
      cappedReason: 'allowance',
    });
  });

  it("adds credit headroom only once an item reaches past the plan's quarters", () => {
    // 8 videos, 7.5 used, 1 pack video. A slideshow (1) and a slideshow (1) fill the plan; the
    // video after them (4) is paid by the pack, which raises the cap by its headroom.
    // The cap leaves 100p after the slideshows: the 241p video fits only with the 250p headroom.
    const capPence = 300 + 2 * typicalItemCostPence('SLIDESHOW', 'STANDARD') + 100;
    const cost: PlanCost = { capPence, spentPence: 300, creditHeadroomPence: 250 };
    const items = capItemsOf(['SLIDESHOW', 'SLIDESHOW', 'VIDEO']);
    const capped = capItems(items, 'STANDARD', enforce(8, 7.5, 1), cost);
    expect(capped).toEqual({ count: 3, quarters: 6, cappedReason: null });
    // Without the pack the video is past the allowance instead.
    expect(capItems(items, 'STANDARD', enforce(8, 7.5), cost)).toEqual({
      count: 2,
      quarters: 2,
      cappedReason: 'allowance',
    });
  });
});
