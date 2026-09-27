import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as killSwitchRoute from '../../src/app/api/studio/admin/kill-switch/route';
import * as redriveRoute from '../../src/app/api/studio/admin/redrive/route';
import * as generateRoute from '../../src/app/api/studio/projects/[id]/generate/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { getKillSwitch } from '../../src/lib/studio/kill-switch';
import { executeJob } from '../../src/lib/studio/queue/workers/runtime';
import { flagKeys } from '../../src/lib/studio/system-flags';
import { call, tenant } from '../helpers/api-harness';
import type { HarnessOptions } from '../helpers/pipeline-harness';
import {
  approve,
  briefBody,
  cleanupGolden,
  connect,
  createProject,
  drain,
  generate,
  getProject,
  getPublication,
  ORG_PREFIX,
  publish,
  rendersOf,
  startJourney,
  type Journey,
} from './journey-kit';

// Phase 12 recovery journeys: the per-platform publishing kill switch and the operator bulk
// re-drive, end to end through the real admin routes and the real workers (inline queue).
//
//   GR-01  Platform kill halts LinkedIn publishing while YouTube publishes; release + re-drive
//          publishes the halted post exactly once. (LinkedIn rather than TikTok: the flag is
//          platform-wide, and the other golden files publish to TikTok in parallel workers.)
//   GR-02  Workspace freeze fails a project mid-pipeline; release + re-drive resumes it without
//          calling the provider again for shots that were already generated
//   GR-03  A project stuck after Redis loses its jobs is re-enqueued and completes
//   GR-04  Non-staff callers get 403 from the re-drive endpoint

const hasDb = Boolean(process.env.DATABASE_URL);
const HOOK_TIMEOUT_MS = 120_000;
const STAFF_ORG = `${ORG_PREFIX}-recovery-staff`;
/** No other suite publishes to it, so halting it platform-wide can't disturb parallel files. */
const HALTED = 'linkedin_video';
const STAFF_CAPS = [
  'studio:admin:kill-switch:read',
  'studio:admin:kill-switch:write',
  'studio:admin:redrive',
];

describe.skipIf(!hasDb)('recovery journeys (kill switch + re-drive)', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const since = new Date();

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.systemFlag.deleteMany({ where: { key: flagKeys.platform(HALTED) } });
    await cleanupGolden(db, since);
    (await getKillSwitch()).invalidate();
    await db.$disconnect();
  }, HOOK_TIMEOUT_MS);

  const journey = (id: string, options: HarnessOptions = {}) => {
    vi.stubEnv('STUDIO_PLATFORM_ORG_IDS', STAFF_ORG);
    return startJourney(db, id, options, { staff: tenant(STAFF_ORG, STAFF_CAPS) });
  };

  const setSwitch = async (body: Record<string, unknown>) => {
    const res = await call(killSwitchRoute.PUT, { method: 'PUT', token: 'staff', body });
    expect(res.status).toBe(200);
  };

  const redrive = async (body: Record<string, unknown>, token = 'staff') =>
    call(redriveRoute.POST, { method: 'POST', token, body });

  const sinceIso = () => new Date(since.getTime() - 60_000).toISOString();

  /** Run the next `n` queued jobs, exactly as the worker would (first attempt). */
  async function runNext(j: Journey, n: number) {
    for (let i = 0; i < n; i += 1) {
      const job = j.h.queue.take();
      if (!job) throw new Error('queue ran dry');
      await executeJob(job.name, job.data as never, j.h.deps, { attemptsMade: 0, maxAttempts: 6 });
    }
  }

  it('GR-01 platform kill halts LinkedIn only; release + re-drive publishes it exactly once', async () => {
    const j = journey('gr01', { probe: { width: 1920, height: 1080 } });
    const projectId = await createProject(
      j,
      briefBody({ targetFormats: [{ platform: HALTED, aspectRatio: '16:9', durationSec: 15 }] }),
    );
    expect((await generate(j, projectId)).state).toBe('READY_FOR_REVIEW');
    await approve(j, projectId);
    const [render] = await rendersOf(j, projectId);
    if (!render) throw new Error('expected a render');
    const linkedin = await connect(j, 'linkedin');
    const youtube = await connect(j, 'youtube');

    await setSwitch({ level: 'platform', target: HALTED, enabled: true, reason: 'app strike' });
    let haltedId = '';
    try {
      haltedId = await publish(j, {
        renderId: render.id,
        platform: HALTED,
        connectionId: linkedin.id,
      });
      const ytId = await publish(j, {
        renderId: render.id,
        platform: 'youtube',
        connectionId: youtube.id,
        title: 'Sourdough',
      });
      await drain(j, { expectClean: false });

      expect((await getPublication(j, ytId)).state).toBe('PUBLISHED');
      const halted = await db.videoPublication.findUniqueOrThrow({ where: { id: haltedId } });
      expect(halted.state).toBe('FAILED');
      expect(halted.errorReason).toMatch(/^kill_switch_platform/);
      // Checked before the upload marker: nothing reached LinkedIn, so a retry is safe.
      expect(j.h.publishers[HALTED].published).toHaveLength(0);
      expect((halted.metadata as { uploadStartedAt?: string }).uploadStartedAt).toBeUndefined();

      // Still engaged: the re-drive refuses it.
      const blocked = await redrive({
        scope: 'kill_switch',
        since: sinceIso(),
        organisationId: j.org,
      });
      expect(blocked.json.items).toEqual([
        expect.objectContaining({
          id: haltedId,
          skippedReason: 'kill_switch_still_engaged: platform',
        }),
      ]);
    } finally {
      await setSwitch({ level: 'platform', target: HALTED, enabled: false, reason: 'restored' });
    }

    // Dry run: the plan, and no change.
    const plan = await redrive({ scope: 'kill_switch', since: sinceIso(), organisationId: j.org });
    expect(plan.json.items).toEqual([
      expect.objectContaining({ id: haltedId, action: 'retry_publication' }),
    ]);
    expect(j.h.queue.pending).toHaveLength(0);
    expect((await getPublication(j, haltedId)).state).toBe('FAILED');

    const applied = await redrive({
      scope: 'kill_switch',
      since: sinceIso(),
      organisationId: j.org,
      dryRun: false,
    });
    expect(applied.json.counts).toEqual({ considered: 1, redriven: 1, skipped: 0 });
    await drain(j);
    expect((await getPublication(j, haltedId)).state).toBe('PUBLISHED');
    expect((await getProject(j, projectId)).state).toBe('PUBLISHED');

    // A repeated re-drive finds nothing and nothing is posted twice.
    const again = await redrive({
      scope: 'kill_switch',
      since: sinceIso(),
      organisationId: j.org,
      dryRun: false,
    });
    expect(again.json.items).toEqual([]);
    await drain(j);
    expect(j.h.publishers[HALTED].published).toHaveLength(1);
    expect(j.api.audits.filter((a) => a.action === 'studio.redrive.run')).toHaveLength(4);
  });

  it('GR-02 workspace freeze mid-pipeline; re-drive resumes without re-paying for finished shots', async () => {
    const j = journey('gr02');
    const id = await createProject(j);
    const res = await call(generateRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id },
      body: {},
    });
    expect(res.status).toBe(202);
    // plan-project, then the first shot's generate-asset (a Runway clip + narration).
    await runNext(j, 2);
    expect(j.h.adapters.runway.requests).toHaveLength(1);

    await setSwitch({ level: 'workspace', target: j.org, enabled: true, reason: 'billing' });
    await drain(j, { expectClean: false });
    const failed = await getProject(j, id);
    expect(failed.state).toBe('FAILED');
    expect(failed.errorReason).toContain('kill_switch_workspace');
    expect(j.h.adapters.runway.requests).toHaveLength(1);
    expect(j.h.adapters.shotstack.requests).toHaveLength(0);

    await setSwitch({ level: 'workspace', target: j.org, enabled: false, reason: 'paid' });
    const plan = await redrive({ scope: 'kill_switch', since: sinceIso(), organisationId: j.org });
    const [item] = plan.json.items as Array<{ id: string; action: string; jobs: string[] }>;
    expect(item).toMatchObject({ id, action: 'resume_assets' });
    expect(item?.jobs).toEqual(['generate-asset', 'generate-asset']); // shots 2 and 3 only
    expect((await getProject(j, id)).state).toBe('FAILED');

    await redrive({
      scope: 'kill_switch',
      since: sinceIso(),
      organisationId: j.org,
      dryRun: false,
    });
    await drain(j);
    expect((await getProject(j, id)).state).toBe('READY_FOR_REVIEW');
    // Shot 1's clip was reused: exactly one more Runway call (shot 2; shot 3 is a text card).
    expect(j.h.adapters.runway.requests).toHaveLength(2);
    const shotIds = j.h.adapters.runway.requests.map((r) => (r as { shotId?: string }).shotId);
    expect(new Set(shotIds).size).toBe(2);
    expect(j.h.adapters.shotstack.requests).toHaveLength(1);
  });

  it('GR-03 a project stuck after Redis loss is re-enqueued under its run and completes', async () => {
    const before = journey('gr03');
    const id = await createProject(before);
    await call(generateRoute.POST, { method: 'POST', token: 'owner', params: { id }, body: {} });
    await runNext(before, 1); // planned; its generate-asset jobs are then lost with Redis
    expect(before.h.queue.pending.length).toBeGreaterThan(0);

    // A fresh worker fleet against an empty Redis: same organisation, new queue.
    const after = journey('gr03');
    const planned = await db.videoProject.findUniqueOrThrow({ where: { id } });
    const runId = (planned.metadata as { runId: string }).runId;
    await db.$executeRaw`UPDATE studio.video_projects SET "updatedAt" = now() - interval '1 hour' WHERE id = ${id}`;

    const plan = await redrive({ scope: 'stuck', organisationId: after.org, stuckMinutes: 30 });
    expect(plan.json.items).toEqual([
      expect.objectContaining({
        id,
        action: 'reenqueue',
        jobs: ['generate-asset', 'generate-asset', 'generate-asset'],
      }),
    ]);
    expect(after.h.queue.pending).toHaveLength(0);

    await redrive({ scope: 'stuck', organisationId: after.org, stuckMinutes: 30, dryRun: false });
    expect(after.h.queue.pending.every((job) => job.data.runId === runId)).toBe(true);
    await drain(after);
    expect((await getProject(after, id)).state).toBe('READY_FOR_REVIEW');
  });

  it('GR-04 non-staff callers cannot re-drive', async () => {
    const j = journey('gr04');
    const res = await redrive({ scope: 'stuck', organisationId: j.org }, 'owner');
    expect(res.status).toBe(403);
    expect(j.api.audits.filter((a) => a.action === 'studio.redrive.run')).toHaveLength(0);
  });
});
