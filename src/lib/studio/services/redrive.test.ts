import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../errors';
import { InlineJobQueue } from '../queue/enqueue';
import {
  isKilledPublication,
  killedStage,
  killLevelOf,
  redrive,
  redriveInput,
  type RedriveInput,
} from './redrive';

// Pure parts of services/redrive.ts. The database behaviour (resume from the killed stage,
// stuck re-enqueue, dry run) is covered in test/api/redrive.test.ts and test/golden/recovery.test.ts.

const NOW = Date.parse('2026-09-27T12:00:00.000Z');

describe('killLevelOf', () => {
  it.each([
    ['kill_switch_workspace: Studio kill switch active (workspace)', 'workspace'],
    ['planning_failed: kill_switch_global: halted', 'global'],
    ['asset_generation_failed: shot 2: kill_switch_project: halted', 'project'],
    ['scheduling failed: kill_switch_platform: halted', 'platform'],
  ])('reads the level from %s', (reason, level) => {
    expect(killLevelOf(reason)).toBe(level);
  });

  it('is undefined for other failures', () => {
    expect(killLevelOf('runway/timeout: slow')).toBeUndefined();
    expect(killLevelOf(null)).toBeUndefined();
  });
});

describe('killedStage', () => {
  it('maps each failure handler prefix to the stage to resume', () => {
    expect(killedStage('planning_failed: kill_switch_workspace: x')).toBe('planning');
    expect(killedStage('asset_generation_failed: shot 2: kill_switch_workspace: x')).toBe('assets');
    expect(killedStage('composition_failed: kill_switch_global: x')).toBe('assets');
    expect(killedStage('quality_gate_error: kill_switch_project: x')).toBe('assets');
  });

  it('refuses reasons it cannot place, and non-kill failures', () => {
    expect(killedStage('kill_switch_workspace: something new')).toBeUndefined();
    expect(killedStage('composition_failed: shotstack/timeout')).toBeUndefined();
    expect(killedStage('cancelled_by_user')).toBeUndefined();
    expect(killedStage(null)).toBeUndefined();
  });
});

describe('isKilledPublication', () => {
  it('accepts publish-video and fire-scheduled kill reasons only', () => {
    expect(isKilledPublication('kill_switch_platform: Studio kill switch active')).toBe(true);
    expect(isKilledPublication('scheduling failed: kill_switch_global: x')).toBe(true);
    expect(isKilledPublication('tiktok/content_policy: rejected (kill_switch_ in caption)')).toBe(
      false,
    );
    expect(isKilledPublication(null)).toBe(false);
  });
});

describe('redriveInput', () => {
  it('defaults to a dry run of 100 items, 30 stuck minutes', () => {
    expect(redriveInput.parse({ scope: 'stuck' })).toEqual({
      scope: 'stuck',
      stuckMinutes: 30,
      dryRun: true,
      limit: 100,
    });
  });

  it('enforces the bounds', () => {
    expect(redriveInput.safeParse({ scope: 'stuck', stuckMinutes: 9 }).success).toBe(false);
    expect(redriveInput.safeParse({ scope: 'stuck', limit: 501 }).success).toBe(false);
    expect(redriveInput.safeParse({ scope: 'kill_switch', level: 'nope' }).success).toBe(false);
    expect(redriveInput.safeParse({ scope: 'stuck', extra: true }).success).toBe(false);
  });
});

describe('redrive — window validation (before any query)', () => {
  const db = {} as PrismaClient;
  const run = (input: Partial<RedriveInput>) =>
    redrive(
      { db, queue: new InlineJobQueue(), now: () => NOW, killSwitch: { check: vi.fn() } as never },
      redriveInput.parse({ scope: 'kill_switch', ...input }),
    );

  it('requires since for the kill_switch scope', async () => {
    await expect(run({})).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a since more than 30 days back, or in the future', async () => {
    await expect(run({ since: '2026-08-27T11:59:00.000Z' })).rejects.toThrow('30 days');
    await expect(run({ since: '2026-09-28T00:00:00.000Z' })).rejects.toThrow('in the past');
  });

  it('refuses a level filter on the stuck scope', async () => {
    await expect(
      redrive(
        { db, queue: new InlineJobQueue(), now: () => NOW },
        redriveInput.parse({ scope: 'stuck', level: 'workspace' }),
      ),
    ).rejects.toThrow('kill_switch scope only');
  });
});
