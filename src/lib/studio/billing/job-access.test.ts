import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { BillingRequiredError, PlanRequiredError } from '../../errors';
import type { TenantAccess } from '../../tenant';
import { billingHoldOf, checkJobAccess, GATED_JOBS } from './job-access';

function deps(
  access: TenantAccess | undefined,
  publication: Record<string, unknown> | null = null,
) {
  const db = {
    videoPublication: {
      findFirst: vi.fn(async () => publication),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const audit = vi.fn();
  return {
    db,
    audit,
    deps: {
      db: db as never,
      billingAccess: access === undefined ? undefined : vi.fn(async () => access),
      audit,
      logger: pino({ level: 'silent' }),
      now: () => Date.parse('2026-09-29T00:00:00Z'),
    },
  };
}

describe('checkJobAccess (worker half of the §P.3 access gate)', () => {
  it('gates generate, render, scan and publish jobs only', () => {
    expect(GATED_JOBS['generate-asset']).toBe('spend');
    expect(GATED_JOBS['compose-video']).toBe('spend');
    expect(GATED_JOBS['scan-website']).toBe('spend');
    expect(GATED_JOBS['publish-video']).toBe('publish');
    expect(GATED_JOBS['poll-publication-analytics']).toBeUndefined();
  });

  it('runs everything with full access, ungated jobs, or no lookup (core mode)', async () => {
    await expect(
      checkJobAccess(deps('full').deps, 'generate-asset', { organisationId: 'o' }),
    ).resolves.toBe('run');
    await expect(
      checkJobAccess(deps('none').deps, 'roll-up-analytics', { organisationId: 'o' }),
    ).resolves.toBe('run');
    await expect(
      checkJobAccess(deps(undefined).deps, 'generate-asset', { organisationId: 'o' }),
    ).resolves.toBe('run');
  });

  it('spend jobs stop with 402 plan_required / billing_required (not retried)', async () => {
    await expect(
      checkJobAccess(deps('none').deps, 'plan-project', { organisationId: 'o' }),
    ).rejects.toBeInstanceOf(PlanRequiredError);
    await expect(
      checkJobAccess(deps('read_only').deps, 'compose-video', { organisationId: 'o' }),
    ).rejects.toBeInstanceOf(BillingRequiredError);
  });

  it('publish jobs are held: the publication stays SCHEDULED with a billing hold, audited once', async () => {
    const d = deps('read_only', { id: 'pub-1', metadata: { connectionId: 'c' } });
    await expect(
      checkJobAccess(d.deps, 'publish-video', { organisationId: 'o', publicationId: 'pub-1' }),
    ).resolves.toBe('held');
    expect(d.db.videoPublication.updateMany).toHaveBeenCalledWith({
      where: { id: 'pub-1', state: 'SCHEDULED' },
      data: {
        metadata: {
          connectionId: 'c',
          billingHold: { at: '2026-09-29T00:00:00.000Z', access: 'read_only' },
        },
      },
    });
    expect(d.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'studio.publication.billing_hold' }),
    );

    const again = deps('read_only', { id: 'pub-1', metadata: { billingHold: { at: 'x' } } });
    await checkJobAccess(again.deps, 'fire-scheduled-publication', {
      organisationId: 'o',
      publicationId: 'pub-1',
    });
    expect(again.db.videoPublication.updateMany).not.toHaveBeenCalled();
  });

  it('reads the hold marker', () => {
    expect(billingHoldOf({ billingHold: { at: '2026-09-29T00:00:00.000Z' } })).toBe(
      '2026-09-29T00:00:00.000Z',
    );
    expect(billingHoldOf({})).toBeNull();
    expect(billingHoldOf(null)).toBeNull();
    expect(billingHoldOf([1])).toBeNull();
  });
});
