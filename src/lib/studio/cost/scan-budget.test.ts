import { describe, expect, it, vi } from 'vitest';
import type { BudgetChecker } from '../providers/router';
import { createScanBudget, DEFAULT_SCAN_COST_CAP_PENCE, scanCostCapPence } from './scan-budget';

const call = (estimatedCostPence: number) => ({
  organisationId: 'org-1',
  providerId: 'anthropic',
  estimatedCostPence,
});

describe('scan cost cap (A10.4 "single scan hard-capped at £0.50")', () => {
  it('defaults to 50p with an env override', () => {
    expect(DEFAULT_SCAN_COST_CAP_PENCE).toBe(50);
    expect(scanCostCapPence({})).toBe(50);
    expect(scanCostCapPence({ STUDIO_SCAN_COST_CAP_PENCE: '20' })).toBe(20);
    expect(scanCostCapPence({ STUDIO_SCAN_COST_CAP_PENCE: '0' })).toBe(50);
  });

  it('reserves accepted estimates and refuses a call that would pass the cap', async () => {
    const inner: BudgetChecker = { hasBudget: vi.fn(async () => true) };
    const budget = createScanBudget(inner, 50);
    expect(await budget.hasBudget(call(30))).toBe(true);
    expect(await budget.hasBudget(call(20))).toBe(true);
    expect(budget.reservedPence()).toBe(50);
    expect(budget.capReached()).toBe(false);
    expect(await budget.hasBudget(call(1))).toBe(false);
    expect(budget.capReached()).toBe(true);
    expect(inner.hasBudget).toHaveBeenCalledTimes(2);
  });

  it('keeps the organisation checks: an inner refusal reserves nothing', async () => {
    const assertNotPaused = vi.fn(async () => undefined);
    const inner: BudgetChecker = { hasBudget: vi.fn(async () => false), assertNotPaused };
    const budget = createScanBudget(inner, 50);
    expect(await budget.hasBudget(call(5))).toBe(false);
    expect(budget.reservedPence()).toBe(0);
    expect(budget.capReached()).toBe(false);
    await budget.assertNotPaused?.({ organisationId: 'org-1', planTier: 'BASIC' });
    expect(assertNotPaused).toHaveBeenCalledOnce();
  });
});
