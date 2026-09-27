import { describe, expect, it, vi } from 'vitest';
import { flagKeys } from '../system-flags';
import { COST_ALERT_SERIES, getMetrics } from './metrics';
import { sampleKillSwitch } from './sample';

describe('sampleKillSwitch', () => {
  it('counts engaged flags per level from one read (fail-closed values count as engaged)', async () => {
    const rows = [
      { key: flagKeys.global() },
      { key: flagKeys.workspace('org-1') },
      { key: flagKeys.workspace('org-2') },
      { key: flagKeys.provider('runway') },
      { key: 'studio.somethingElse' },
    ];
    const findMany = vi.fn(async () => rows);
    const metrics = getMetrics();
    await sampleKillSwitch(metrics, { systemFlag: { findMany } } as never);

    expect(findMany).toHaveBeenCalledWith({
      where: { key: { startsWith: 'studio.' }, NOT: { value: 'false' } },
      select: { key: true },
    });
    const values = Object.fromEntries(
      (await metrics.killSwitchEngaged.get()).values.map((v) => [v.labels.level, v.value]),
    );
    expect(values).toMatchObject({ global: 1, workspace: 2, project: 0, provider: 1 });
  });

  it('resets a level to 0 when its flags are released', async () => {
    const metrics = getMetrics();
    await sampleKillSwitch(metrics, {
      systemFlag: { findMany: vi.fn(async () => []) },
    } as never);
    const values = (await metrics.killSwitchEngaged.get()).values;
    expect(values.every((v) => v.value === 0)).toBe(true);
  });
});

describe('studio_cost_alerts_total', () => {
  it('exposes every (scope, threshold) series at 0 before any alert (for increase())', async () => {
    const text = await getMetrics().registry.metrics();
    for (const { scope, threshold } of COST_ALERT_SERIES) {
      expect(text).toMatch(
        new RegExp(`studio_cost_alerts_total\\{scope="${scope}",threshold="${threshold}"`),
      );
    }
    expect(COST_ALERT_SERIES).toHaveLength(11);
  });
});
