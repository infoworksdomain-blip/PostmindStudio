import { describe, expect, it, vi } from 'vitest';
import { CostCapPausedError } from '../../errors';
import {
  autoResumeEnabled,
  capPeriod,
  recordCostPause,
  skipReason,
  type CostPauseMarker,
} from './auto-resume';
import type { ProjectRow } from './redrive';

// BACKLOG 13.20 — pure rules of the rollover auto-resume (the database path is covered by
// test/api/auto-resume.test.ts and test/golden/admin-automation.test.ts).

const NOW = new Date('2026-09-29T00:05:00Z');

function project(
  pause: Partial<CostPauseMarker> | null,
  over: { metadata?: Record<string, unknown>; shots?: ProjectRow['scripts'][number]['shots'] } = {},
): ProjectRow {
  return {
    id: 'prj-1',
    organisationId: 'org-1',
    metadata: {
      runId: 'run-1',
      planTier: 'STANDARD',
      ...(pause && {
        costPause: {
          scope: 'org_daily',
          job: 'generate-asset',
          period: '2026-09-28',
          at: '2026-09-28T15:00:00Z',
          ...pause,
        },
      }),
      ...over.metadata,
    },
    scripts: [{ shots: over.shots ?? [] }],
  } as unknown as ProjectRow;
}

describe('capPeriod', () => {
  it('is the UTC day for daily scopes and the UTC month for the monthly cap', () => {
    expect(capPeriod('org_daily', NOW)).toBe('2026-09-29');
    expect(capPeriod('org_monthly', NOW)).toBe('2026-09');
    expect(capPeriod('global_daily', NOW)).toBe('2026-09-29');
  });
});

describe('skipReason', () => {
  it('resumes an org daily pause from yesterday and a monthly pause from last month', () => {
    expect(skipReason(project({}), NOW)).toBeUndefined();
    expect(
      skipReason(project({ scope: 'org_monthly', period: '2026-08', job: 'plan-project' }), NOW),
    ).toBeUndefined();
  });

  it('waits while the cap period has not rolled over', () => {
    expect(skipReason(project({ period: '2026-09-29' }), NOW)).toMatch(/not rolled over/);
    expect(skipReason(project({ scope: 'org_monthly', period: '2026-09' }), NOW)).toMatch(
      /not rolled over/,
    );
  });

  it('never resumes project-budget or global pauses, opted-out projects, or unknown stages', () => {
    expect(skipReason(project({ scope: 'project' }), NOW)).toMatch(/not resumed automatically/);
    expect(skipReason(project({ scope: 'global_daily' }), NOW)).toMatch(/not resumed/);
    expect(skipReason(project({}, { metadata: { autoResume: false } }), NOW)).toMatch(/turned off/);
    expect(skipReason(project({ job: 'publish-video' }), NOW)).toMatch(/resume by hand/);
    expect(skipReason(project(null), NOW)).toMatch(/not recorded/);
    expect(skipReason(project({}, { metadata: { planTier: undefined } }), NOW)).toMatch(
      /plan tier/,
    );
  });

  it('skips runs whose shots failed for reasons other than the pause', () => {
    const paused = { id: 's1', state: 'FAILED', errorReason: 'cost_cap_paused: org' } as const;
    const broken = {
      id: 's2',
      state: 'FAILED',
      errorReason: 'runway/provider_error: 500',
    } as const;
    expect(skipReason(project({}, { shots: [paused] as never }), NOW)).toBeUndefined();
    expect(skipReason(project({}, { shots: [paused, broken] as never }), NOW)).toMatch(
      /other reasons/,
    );
  });
});

describe('autoResumeEnabled', () => {
  it('defaults on; only an explicit false opts out', () => {
    expect(autoResumeEnabled({})).toBe(true);
    expect(autoResumeEnabled(null)).toBe(true);
    expect(autoResumeEnabled({ autoResume: false })).toBe(false);
  });
});

describe('recordCostPause', () => {
  it('stores scope, job and period on the run', async () => {
    const $executeRaw = vi.fn(async () => 1);
    await recordCostPause(
      { db: { $executeRaw } as never, now: () => NOW.getTime() },
      { projectId: 'prj-1', runId: 'run-1' },
      'generate-asset',
      new CostCapPausedError('org_monthly', 'monthly cap reached'),
    );
    const call = $executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    const patch = JSON.parse(String(call[1])) as { costPause: CostPauseMarker };
    expect(patch.costPause).toMatchObject({
      scope: 'org_monthly',
      job: 'generate-asset',
      period: '2026-09',
    });
  });

  it('does nothing for work that belongs to no project', async () => {
    const $executeRaw = vi.fn();
    await recordCostPause(
      { db: { $executeRaw } as never, now: () => 0 },
      { runId: 'r' },
      'ingest-library-video',
      new CostCapPausedError('org_daily', 'x'),
    );
    expect($executeRaw).not.toHaveBeenCalled();
  });
});
