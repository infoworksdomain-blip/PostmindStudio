import pino from 'pino';
import { Counter, Registry } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '../../audit';
import { CostCapPausedError } from '../../errors';
import type {
  NotificationInput,
  Notifier,
  StaffNotificationInput,
} from '../notifications/notifier';
import type { CostCaps } from './caps';
import {
  alertMessage,
  createCostGuard,
  isPaused,
  type CapUsage,
  type CostGuardDeps,
} from './guard';

// Unit tests over an in-memory stand-in for the three Prisma delegates the guard uses.

interface Project {
  id: string;
  name: string;
  organisationId: string;
  createdByUserId: string;
  costBudgetPence: number | null;
  costActualPence: number;
}
interface Usage {
  organisationId: string;
  provider: string;
  costPence: number;
}
type AlertRow = { scope: string; scopeId: string; period: string; threshold: number };

const NOW = Date.parse('2026-09-27T12:00:00Z');

function fakeDb(projects: Project[], usage: Usage[]) {
  const alerts: Array<AlertRow & Record<string, unknown>> = [];
  const db = {
    videoProject: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          projects.find((p) => p.id === where.id) ?? null,
      ),
    },
    providerUsage: {
      aggregate: vi.fn(async ({ where }: { where: { organisationId?: string } }) => ({
        _sum: {
          costPence: usage
            .filter((u) => !where.organisationId || u.organisationId === where.organisationId)
            .reduce((sum, u) => sum + u.costPence, 0),
        },
      })),
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { organisationId_provider_day: { organisationId: string; provider: string } };
        }) => {
          const key = where.organisationId_provider_day;
          const row = usage.find(
            (u) => u.organisationId === key.organisationId && u.provider === key.provider,
          );
          return row ? { costPence: row.costPence } : null;
        },
      ),
    },
    costAlert: {
      createManyAndReturn: vi.fn(
        async ({ data }: { data: Array<AlertRow & Record<string, unknown>> }) => {
          const out: Array<{ id: string }> = [];
          for (const row of data) {
            const dup = alerts.some(
              (a) =>
                a.scope === row.scope &&
                a.scopeId === row.scopeId &&
                a.period === row.period &&
                a.threshold === row.threshold,
            );
            if (dup) continue;
            alerts.push(row);
            out.push({ id: `alert_${alerts.length}` });
          }
          return out;
        },
      ),
    },
  };
  return { db, alerts };
}

function setup(options: { projects?: Project[]; usage?: Usage[]; caps?: Partial<CostCaps> } = {}) {
  const { db, alerts } = fakeDb(options.projects ?? [], options.usage ?? []);
  const notified: NotificationInput[] = [];
  const staff: StaffNotificationInput[] = [];
  const notifier: Notifier = {
    notify: vi.fn(async (input: NotificationInput) => {
      notified.push(input);
      return { created: true, id: 'n1' };
    }),
    notifyStaff: vi.fn(async (input: StaffNotificationInput) => {
      staff.push(input);
      return 1;
    }),
  };
  const audits: AuditEntry[] = [];
  const registry = new Registry();
  const costAlerts = new Counter({
    name: 'test_cost_alerts_total',
    help: 'test',
    labelNames: ['scope', 'threshold'] as const,
    registers: [registry],
  });
  const logger = pino({ level: 'silent' });
  const warn = vi.spyOn(logger, 'warn');
  const deps: CostGuardDeps = {
    db: db as unknown as CostGuardDeps['db'],
    caps: { orgDailyPenceByTier: {}, ...options.caps },
    notifier,
    audit: (e) => audits.push(e),
    logger,
    metrics: { costAlerts },
    now: () => NOW,
  };
  const guard = createCostGuard(deps);
  const count = async (scope: string, threshold: string) =>
    (await costAlerts.get()).values.find(
      (v) => v.labels.scope === scope && v.labels.threshold === threshold,
    )?.value ?? 0;
  return { guard, db, alerts, notified, staff, audits, warn, count };
}

const project = (over: Partial<Project> = {}): Project => ({
  id: 'proj-1',
  name: 'Launch',
  organisationId: 'org-1',
  createdByUserId: 'user-1',
  costBudgetPence: 1000,
  costActualPence: 0,
  ...over,
});

const scope = { organisationId: 'org-1', projectId: 'proj-1', planTier: 'STANDARD' as const };

describe('createCostGuard — project cap (spec 12.5)', () => {
  it('does nothing below 80% or without a budget', async () => {
    const { guard, alerts } = setup({ projects: [project({ costActualPence: 790 })] });
    await guard.assertNotPaused(scope);
    const none = setup({ projects: [project({ costBudgetPence: null, costActualPence: 99_999 })] });
    await none.guard.assertNotPaused(scope);
    expect(alerts).toHaveLength(0);
    expect(none.alerts).toHaveLength(0);
  });

  it('raises the 80% alert exactly once and fans it out', async () => {
    const t = setup({ projects: [project({ costActualPence: 800 })] });
    await t.guard.assertNotPaused(scope);
    await t.guard.assertNotPaused(scope);
    await t.guard.recordSpend({ ...scope, providerId: 'runway' });
    expect(t.alerts).toEqual([
      expect.objectContaining({
        scope: 'PROJECT',
        scopeId: 'proj-1',
        period: 'budget:1000',
        threshold: 80,
        capPence: 1000,
        spentPence: 800,
      }),
    ]);
    expect(await t.count('project', '80')).toBe(1);
    expect(t.audits).toEqual([
      expect.objectContaining({
        action: 'studio.cost.alert',
        organisationId: 'org-1',
        resource: { type: 'cost_alert', id: 'alert_1' },
      }),
    ]);
    expect(t.warn).toHaveBeenCalledWith(expect.objectContaining({ threshold: 80 }), 'cost alert');
    expect(t.notified).toEqual([
      expect.objectContaining({
        organisationId: 'org-1',
        userId: 'user-1',
        kind: 'cost_alert',
        link: '/projects/proj-1',
        dedupeKey: 'cost:PROJECT|proj-1|budget:1000|80',
      }),
    ]);
  });

  it('a second process that loses the insert race does not fan out again', async () => {
    const t = setup({ projects: [project({ costActualPence: 850 })] });
    t.alerts.push({ scope: 'PROJECT', scopeId: 'proj-1', period: 'budget:1000', threshold: 80 });
    await t.guard.assertNotPaused(scope);
    expect(t.notified).toHaveLength(0);
    expect(await t.count('project', '80')).toBe(0);
  });

  it('pauses at 90% with a cost_paused notification', async () => {
    const t = setup({ projects: [project({ costActualPence: 900 })] });
    const err = await t.guard.assertNotPaused(scope).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CostCapPausedError);
    expect(err).toMatchObject({ scope: 'project', details: { spentPence: 900, capPence: 1000 } });
    expect((err as Error).message).toContain('90% of its budget (£9.00 of £10.00)');
    expect(t.notified.map((n) => n.kind)).toEqual(['cost_alert', 'cost_paused']);
    expect(t.alerts.map((a) => a.threshold)).toEqual([80, 90]);
  });

  it('re-arms the alerts when the budget is raised', async () => {
    const row = project({ costActualPence: 900 });
    const t = setup({ projects: [row] });
    await expect(t.guard.assertNotPaused(scope)).rejects.toBeInstanceOf(CostCapPausedError);
    row.costBudgetPence = 2_000; // PATCH /projects/:id
    await t.guard.assertNotPaused(scope); // resumes: 45%
    row.costActualPence = 1_700;
    await t.guard.recordSpend({ ...scope, providerId: 'runway' });
    expect(t.alerts.map((a) => `${a.period}@${a.threshold}`)).toEqual([
      'budget:1000@80',
      'budget:1000@90',
      'budget:2000@80',
    ]);
  });
});

describe('createCostGuard — daily caps', () => {
  it('pauses an organisation at its tier cap and says publishing continues', async () => {
    const t = setup({
      usage: [
        { organisationId: 'org-1', provider: 'runway', costPence: 300 },
        { organisationId: 'org-1', provider: 'elevenlabs', costPence: 200 },
        { organisationId: 'org-2', provider: 'runway', costPence: 10_000 },
      ],
      caps: { orgDailyPenceByTier: { STANDARD: 500, PLUS: 5_000 } },
    });
    const err = await t.guard
      .assertNotPaused({ organisationId: 'org-1', planTier: 'STANDARD' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ scope: 'org_daily' });
    expect(t.alerts.map((a) => [a.scope, a.threshold, a.period])).toEqual([
      ['ORG_DAILY', 80, '2026-09-27'],
      ['ORG_DAILY', 100, '2026-09-27'],
    ]);
    const paused = t.notified.find((n) => n.kind === 'cost_paused');
    expect(paused).toMatchObject({ organisationId: 'org-1', userId: null });
    expect(paused?.body).toContain('publishing is not affected');
    // Same spend on a bigger tier is fine.
    await setup({
      usage: [{ organisationId: 'org-1', provider: 'runway', costPence: 500 }],
      caps: { orgDailyPenceByTier: { STANDARD: 500, PLUS: 5_000 } },
    }).guard.assertNotPaused({ organisationId: 'org-1', planTier: 'PLUS' });
  });

  it('pauses everything at the global cap and notifies staff, not the organisation', async () => {
    const t = setup({
      usage: [
        { organisationId: 'org-1', provider: 'runway', costPence: 600 },
        { organisationId: 'org-2', provider: 'luma', costPence: 400 },
      ],
      caps: { globalDailyPence: 1000 },
    });
    await expect(
      t.guard.assertNotPaused({ organisationId: 'org-3', planTier: 'BASIC' }),
    ).rejects.toMatchObject({ scope: 'global_daily' });
    expect(t.notified).toHaveLength(0);
    expect(t.staff.map((s) => s.kind)).toEqual(['cost_alert', 'cost_paused']);
    expect(t.audits[0]).toMatchObject({ organisationId: 'postmind-platform' });
    expect(await t.count('global_daily', '100')).toBe(1);
  });

  it('alerts on the per-provider cap after spend but never pauses on it', async () => {
    const t = setup({
      usage: [{ organisationId: 'org-1', provider: 'runway', costPence: 1_000 }],
      caps: { orgProviderDailyPence: 1_000 },
    });
    await t.guard.recordSpend({ organisationId: 'org-1', planTier: 'BASIC', providerId: 'runway' });
    await t.guard.assertNotPaused({ organisationId: 'org-1', planTier: 'BASIC' });
    expect(t.alerts.map((a) => [a.scope, a.scopeId, a.threshold])).toEqual([
      ['ORG_PROVIDER_DAILY', 'org-1/runway', 80],
      ['ORG_PROVIDER_DAILY', 'org-1/runway', 100],
    ]);
    expect(t.notified.every((n) => n.kind === 'cost_alert')).toBe(true);
  });

  it('never fails generation because alerting failed', async () => {
    const t = setup({ projects: [project({ costActualPence: 850 })] });
    t.db.costAlert.createManyAndReturn.mockRejectedValue(new Error('db blip'));
    await expect(t.guard.assertNotPaused(scope)).resolves.toBeUndefined();
    await expect(t.guard.recordSpend({ ...scope, providerId: 'runway' })).resolves.toBeUndefined();
  });

  it('fails closed when spend cannot be read', async () => {
    const t = setup({ projects: [project()] });
    t.db.videoProject.findUnique.mockRejectedValue(new Error('db down'));
    await expect(t.guard.assertNotPaused(scope)).rejects.toThrow('db down');
  });
});

describe('alertMessage / isPaused', () => {
  const base: CapUsage = {
    scope: 'ORG_PROVIDER_DAILY',
    scopeId: 'o/runway',
    organisationId: 'o',
    period: '2026-09-27',
    capPence: 100,
    spentPence: 100,
    thresholds: [80, 100],
    provider: 'runway',
  };
  it('never treats a provider cap as a generation pause', () => {
    expect(isPaused(base)).toBe(false);
    expect(alertMessage(base, 100)).toMatchObject({ kind: 'cost_alert' });
    expect(alertMessage(base, 100).title).toContain('runway');
  });
  it('words the 80% project alert with the pause point', () => {
    expect(
      alertMessage(
        {
          ...base,
          scope: 'PROJECT',
          scopeId: 'p',
          project: { id: 'p', name: 'X', createdByUserId: 'u' },
        },
        80,
      ).body,
    ).toContain('pauses at 90%');
  });
});
