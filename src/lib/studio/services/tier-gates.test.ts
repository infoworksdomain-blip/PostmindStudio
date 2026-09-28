import { describe, expect, it, vi } from 'vitest';
import { PlanTierError, QuotaExceededError } from '../../errors';
import type { PlanTier } from '../providers/router';
import {
  assertImageGenerationAllowed,
  assertScanBusinessAllowed,
  assertTierGate,
  DEFAULT_IMAGE_GENERATION_MONTHLY_CAP,
  imageGenerationCap,
  monthWindow,
  SCANNED_BUSINESS_LIMITS,
  TIER_GATES,
  tierAtLeast,
  type TierGate,
} from './tier-gates';

const tenantOn = (planTier: string) => ({
  organisationId: 'org-1',
  organisation: { id: 'org-1', planTier },
});

describe('A10.3 tier gates (15.D2)', () => {
  // Table from Addendum A10.3; columns Basic / Standard / Plus / Enterprise.
  const table: Array<[TierGate, [boolean, boolean, boolean, boolean], PlanTier]> = [
    ['library.inspire', [false, true, true, true], 'STANDARD'],
    ['library.template', [false, false, true, true], 'PLUS'],
    ['overlays.custom_presets', [false, true, true, true], 'STANDARD'],
    ['slideshow.custom_templates', [false, true, true, true], 'STANDARD'],
    ['image_library.generate', [false, false, true, true], 'PLUS'],
  ];
  const tiers: PlanTier[] = ['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE'];

  it('covers every gate in the table', () => {
    expect(Object.keys(TIER_GATES).sort()).toEqual(table.map(([g]) => g).sort());
  });

  for (const [gate, allowed, requiredTier] of table) {
    for (const [i, tier] of tiers.entries()) {
      it(`${gate} on ${tier}: ${allowed[i] ? 'allowed' : `403 plan_tier (${requiredTier})`}`, () => {
        const run = () => assertTierGate(tenantOn(tier), gate);
        if (allowed[i]) {
          expect(run).not.toThrow();
          return;
        }
        try {
          run();
          expect.unreachable('expected PlanTierError');
        } catch (err) {
          expect(err).toBeInstanceOf(PlanTierError);
          const e = err as PlanTierError;
          expect(e.status).toBe(403);
          expect(e.code).toBe('plan_tier');
          expect(e.details).toMatchObject({ requiredTier, gate, planTier: tier });
        }
      });
    }
  }

  it('treats an unknown or missing tier as Basic', () => {
    expect(() => assertTierGate(tenantOn('gold'), 'library.inspire')).toThrow(PlanTierError);
    expect(() => assertTierGate(tenantOn('standard'), 'library.inspire')).not.toThrow();
  });

  it('orders tiers', () => {
    expect(tierAtLeast('PLUS', 'STANDARD')).toBe(true);
    expect(tierAtLeast('BASIC', 'STANDARD')).toBe(false);
    expect(tierAtLeast('ENTERPRISE', 'ENTERPRISE')).toBe(true);
  });
});

describe('monthWindow (UTC calendar month)', () => {
  it('spans the month and rolls over at midnight UTC', () => {
    const last = monthWindow(Date.parse('2026-09-30T23:59:59.999Z'));
    expect(last.key).toBe('2026-09');
    expect(last.start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(last.end.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(monthWindow(Date.parse('2026-10-01T00:00:00.000Z')).key).toBe('2026-10');
    expect(monthWindow(Date.parse('2026-12-15T12:00:00Z')).end.toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });
});

function scanDb(businesses: string[]) {
  return {
    websiteScan: {
      findFirst: vi.fn(async ({ where }: { where: { businessId: string } }) =>
        businesses.includes(where.businessId) ? { id: 'scan' } : null,
      ),
      findMany: vi.fn(async () => businesses.map((businessId) => ({ businessId }))),
    },
  };
}

describe('website scans: 1 / 3 / 10 / unlimited businesses (A10.3)', () => {
  it('has the spec limits', () => {
    expect(SCANNED_BUSINESS_LIMITS).toEqual({ BASIC: 1, STANDARD: 3, PLUS: 10, ENTERPRISE: null });
  });

  it('allows a rescan of an already scanned business at the limit', async () => {
    const db = scanDb(['biz-a']);
    await expect(
      assertScanBusinessAllowed(db as never, tenantOn('BASIC'), 'biz-a'),
    ).resolves.toBeUndefined();
  });

  it('refuses a new business beyond the limit with the next tier that allows it', async () => {
    const err = await assertScanBusinessAllowed(
      scanDb(['biz-a']) as never,
      tenantOn('BASIC'),
      'biz-b',
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanTierError);
    expect((err as PlanTierError).details).toMatchObject({
      requiredTier: 'STANDARD',
      limit: 1,
      scannedBusinesses: 1,
    });
    const three = ['a', 'b', 'c'];
    const std = await assertScanBusinessAllowed(
      scanDb(three) as never,
      tenantOn('STANDARD'),
      'd',
    ).catch((e: unknown) => e);
    expect((std as PlanTierError).requiredTier).toBe('PLUS');
    await expect(
      assertScanBusinessAllowed(scanDb(three) as never, tenantOn('PLUS'), 'd'),
    ).resolves.toBeUndefined();
  });

  it('never limits Enterprise (no query)', async () => {
    const db = scanDb(Array.from({ length: 50 }, (_, i) => `b${i}`));
    await assertScanBusinessAllowed(db as never, tenantOn('ENTERPRISE'), 'new');
    expect(db.websiteScan.findMany).not.toHaveBeenCalled();
  });
});

describe('image generation monthly cap per business (A10.4)', () => {
  it('has the spec defaults and env overrides', () => {
    expect(DEFAULT_IMAGE_GENERATION_MONTHLY_CAP).toEqual({
      BASIC: 20,
      STANDARD: 50,
      PLUS: 200,
      ENTERPRISE: 1000,
    });
    expect(imageGenerationCap('PLUS', { STUDIO_IMAGE_GEN_MONTHLY_CAP_PLUS: '5' })).toBe(5);
    expect(imageGenerationCap('PLUS', { STUDIO_IMAGE_GEN_MONTHLY_CAP_PLUS: 'lots' })).toBe(200);
  });

  it('counts GENERATED rows of the business in the UTC month and refuses at the cap', async () => {
    const count = vi.fn(async () => 200);
    const db = { imageLibraryItem: { count } };
    const scope = { organisationId: 'org-1', businessId: 'biz-1', planTier: 'PLUS' as const };
    const now = Date.parse('2026-09-28T10:00:00Z');
    const err = await assertImageGenerationAllowed(db as never, scope, now, {}).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect((err as QuotaExceededError).code).toBe('quota_exceeded');
    expect((err as QuotaExceededError).details).toMatchObject({
      quota: 'image_generation',
      used: 200,
      cap: 200,
      resetsAt: '2026-10-01T00:00:00.000Z',
    });
    expect(count).toHaveBeenCalledWith({
      where: {
        organisationId: 'org-1',
        businessId: 'biz-1',
        source: 'GENERATED',
        createdAt: {
          gte: new Date('2026-09-01T00:00:00.000Z'),
          lt: new Date('2026-10-01T00:00:00.000Z'),
        },
      },
    });
    count.mockResolvedValueOnce(199);
    await expect(assertImageGenerationAllowed(db as never, scope, now, {})).resolves.toMatchObject({
      remaining: 1,
    });
  });
});
