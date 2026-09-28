import { describe, expect, it } from 'vitest';
import { ConfigurationError, ValidationError } from '../../../errors';
import {
  buildKillSwitchPlans,
  levelSeconds,
  levelSection,
  levelVerdict,
  renderDeployCommand,
  ROLLBACK_SLO_MS,
  rollbackSections,
  waitForReady,
  type RollbackPhase,
} from './rehearse';

describe('buildKillSwitchPlans', () => {
  it('orders levels least-disruptive first and applies defaults and env targets', () => {
    const { plans, skipped } = buildKillSwitchPlans(
      ['global', 'workspace', 'provider', 'platform', 'project'],
      { project: 'proj-1' },
      { REHEARSE_WORKSPACE_ID: 'org-9' },
    );
    expect(plans.map((p) => `${p.level}:${p.target ?? ''}`)).toEqual([
      'provider:runway',
      'platform:tiktok',
      'project:proj-1',
      'workspace:org-9',
      'global:',
    ]);
    expect(skipped).toEqual([]);
    expect(plans[0]?.reason).toContain('staging gate 14.6');
  });

  it('skips scoped levels without a target, with the reason', () => {
    const { plans, skipped } = buildKillSwitchPlans(['workspace', 'project'], {});
    expect(plans).toEqual([]);
    expect(skipped.map((s) => s.level)).toEqual(['project', 'workspace']);
    expect(skipped[0]?.reason).toContain('REHEARSE_PROJECT_ID');
  });

  it('rejects unknown providers and platforms', () => {
    expect(() => buildKillSwitchPlans(['provider'], { provider: 'acme' })).toThrow(ValidationError);
    expect(() => buildKillSwitchPlans(['platform'], { platform: 'myspace' })).toThrow(
      'Unknown platform',
    );
  });
});

describe('level outcomes', () => {
  const plan = { level: 'platform' as const, target: 'tiktok', reason: 'r' };
  it('maps each outcome to a verdict, a section and a time', () => {
    const halt = {
      plan,
      kind: 'halt' as const,
      activityBefore: 4,
      result: { halted: true, elapsedMs: 12_300, withinSlo: true, observedMs: 90_000, samples: [] },
    };
    expect(levelVerdict(halt)).toBe('PASS');
    // No in-scope work before engaging and nothing in flight: the timing proves nothing.
    const idle = { ...halt, activityBefore: 0 };
    expect(levelVerdict(idle)).toBe('INCOMPLETE');
    expect(levelSection(idle).lines[0]).toContain('no in-scope work');
    expect(levelSeconds(halt)).toBe('12.3');
    expect(levelSection(halt).title).toBe('Kill switch — platform (tiktok)');

    const drain = {
      plan: { level: 'global' as const, reason: 'r' },
      kind: 'drain' as const,
      result: { drained: true, elapsedMs: 70_000, withinSlo: false, samples: [] },
    };
    expect(levelVerdict(drain)).toBe('FAIL');
    const loaded = { atMs: 0, active: { 'studio-assets': 3 } };
    const within = { drained: true, elapsedMs: 20_000, withinSlo: true };
    expect(levelVerdict({ ...drain, result: { ...within, samples: [loaded] } })).toBe('PASS');
    expect(
      levelVerdict({ ...drain, result: { ...within, samples: [{ atMs: 0, active: {} }] } }),
    ).toBe('INCOMPLETE');

    const unmeasured = { plan, kind: 'unmeasured' as const, note: 'set STAGING_DATABASE_URL' };
    expect(levelVerdict(unmeasured)).toBe('INCOMPLETE');
    expect(levelSeconds(unmeasured)).toBe('—');

    const error = { plan, kind: 'error' as const, message: 'PUT failed: 403' };
    expect(levelVerdict(error)).toBe('FAIL');
    expect(levelSection(error).lines[0]).toContain('403');
  });
});

describe('renderDeployCommand', () => {
  it('substitutes every {tag}', () => {
    expect(
      renderDeployCommand('IMAGE_TAG={tag} docker compose up -d && echo {tag}', 'a1b2c3'),
    ).toBe('IMAGE_TAG=a1b2c3 docker compose up -d && echo a1b2c3');
  });

  it('requires a template with {tag} and a safe tag', () => {
    expect(() => renderDeployCommand(undefined, 'x')).toThrow(ConfigurationError);
    expect(() => renderDeployCommand('deploy latest', 'x')).toThrow('{tag}');
    expect(() => renderDeployCommand('deploy {tag}', '$(whoami)')).toThrow(ValidationError);
  });
});

describe('waitForReady', () => {
  function clock(statuses: number[]) {
    let t = 0;
    let i = 0;
    return {
      probe: async () => statuses[Math.min(i++, statuses.length - 1)] as number,
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  }

  it('records the first 200 of a stable run', async () => {
    const r = await waitForReady(clock([503, 0, 200, 503, 200, 200, 200]), {
      startedAt: 0,
      intervalMs: 5_000,
    });
    expect(r).toMatchObject({ ready: true, elapsedMs: 20_000 });
  });

  it('gives up at the timeout', async () => {
    const r = await waitForReady(clock([503]), {
      startedAt: 0,
      intervalMs: 5_000,
      timeoutMs: 20_000,
    });
    expect(r.ready).toBe(false);
    await expect(waitForReady(clock([200]), { startedAt: 0, stableSamples: 0 })).rejects.toThrow(
      ValidationError,
    );
  });
});

describe('rollbackSections', () => {
  const phase = (tag: string, elapsedMs: number, ready = true, exit = 0): RollbackPhase => ({
    tag,
    deployExitCode: exit,
    deployMs: 40_000,
    ready: { ready, elapsedMs, samples: [{ atMs: elapsedMs, status: ready ? 200 : 503 }] },
  });

  it('passes a rollback within 5 minutes', () => {
    const r = rollbackSections({
      fromTag: 'n',
      toTag: 'n1',
      forward: phase('n1', 90_000),
      rollback: phase('n', 120_000),
    });
    expect(r.verdict).toBe('PASS');
    expect(r.rollbackSeconds).toBe('120.0');
    expect(r.sections[1]?.lines[0]).toContain('PASS');
  });

  it('fails over the SLO or when the deploy fails', () => {
    expect(
      rollbackSections({
        fromTag: 'n',
        toTag: 'n1',
        forward: phase('n1', 90_000),
        rollback: phase('n', ROLLBACK_SLO_MS + 1),
      }).verdict,
    ).toBe('FAIL');
    expect(
      rollbackSections({
        fromTag: 'n',
        toTag: 'n1',
        forward: phase('n1', 90_000),
        rollback: phase('n', 60_000, true, 1),
      }).sections[1]?.lines[0],
    ).toContain('deploy exited 1');
  });

  it('does not time a rollback when N+1 never became ready', () => {
    const r = rollbackSections({ fromTag: 'n', toTag: 'n1', forward: phase('n1', 900_000, false) });
    expect(r.verdict).toBe('FAIL');
    expect(r.sections[1]?.verdict).toBe('INCOMPLETE');
    expect(r.rollbackSeconds).toBe('—');
  });
});
