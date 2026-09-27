import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as projectRoute from '../../src/app/api/studio/projects/[id]/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { InlineJobQueue } from '../../src/lib/studio/queue/enqueue';
import { resumeCostPausedProjects } from '../../src/lib/studio/services/auto-resume';
import { call, installApi, tenant } from '../helpers/api-harness';

// BACKLOG 13.20 — rollover auto-resume on a real database: org daily/monthly pauses from an
// earlier period resume from the paused stage under a new run; same-period, opted-out and
// project-budget pauses stay; PATCH /projects/:id { autoResume } works in any state.

const hasDb = Boolean(process.env.DATABASE_URL);
const NOW = Date.parse('2026-10-01T00:05:00Z');

describe.skipIf(!hasDb)('cost-cap auto-resume', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-resume-${randomUUID()}`;
  let api: ReturnType<typeof installApi>;

  beforeAll(() => {
    api = installApi(db, { owner: tenant(org), reader: tenant(org, ['studio:project:read']) });
  });

  afterAll(async () => {
    setApiDeps(undefined);
    const ids = (await db.videoProject.findMany({ where: { organisationId: org } })).map(
      (p) => p.id,
    );
    await db.videoShot.deleteMany({ where: { script: { projectId: { in: ids } } } });
    await db.videoScript.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.notification.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  async function paused(
    name: string,
    costPause: Record<string, unknown> | null,
    extra: Record<string, unknown> = {},
    errorReason = 'cost_cap_paused: organisation daily cost cap reached',
  ) {
    const project = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: 'biz',
        createdByUserId: 'user-1',
        name,
        state: 'FAILED',
        sourceType: 'BRIEF',
        targetFormats: [],
        errorReason,
        updatedAt: new Date(NOW - 10 * 3_600_000),
        metadata: {
          runId: `run-${randomUUID()}`,
          planTier: 'STANDARD',
          renders: {},
          ...(costPause && { costPause }),
          ...extra,
        } as Prisma.InputJsonValue,
      },
    });
    const script = await db.videoScript.create({
      data: {
        projectId: project.id,
        targetPlatform: 'tiktok',
        targetAspectRatio: '9:16',
        targetDurationSec: 15,
        fullText: 'x',
        scriptModel: 'test',
      },
    });
    const shot = (sortOrder: number, state: 'READY' | 'FAILED', errorReason: string | null) =>
      db.videoShot.create({
        data: {
          scriptId: script.id,
          sortOrder,
          durationSec: 5,
          visualTreatment: 'AI_CLIP',
          sceneDescription: 'bread',
          state,
          errorReason,
        },
      });
    await shot(0, 'READY', null);
    await shot(1, 'FAILED', 'cost_cap_paused: organisation daily cost cap reached');
    return project;
  }

  it('resumes yesterday’s org daily pause from the asset stage, once', async () => {
    const daily = await paused('Daily pause', {
      scope: 'org_daily',
      job: 'generate-asset',
      period: '2026-09-30',
      at: '2026-09-30T15:00:00Z',
    });
    const monthly = await paused('Monthly pause', {
      scope: 'org_monthly',
      job: 'plan-project',
      period: '2026-09',
      at: '2026-09-29T10:00:00Z',
    });
    const today = await paused('Paused today', {
      scope: 'org_daily',
      job: 'generate-asset',
      period: '2026-10-01',
      at: '2026-10-01T00:01:00Z',
    });
    const optedOut = await paused(
      'Opted out',
      { scope: 'org_daily', job: 'generate-asset', period: '2026-09-30', at: 'x' },
      { autoResume: false },
    );
    const budget = await paused(
      'Project budget',
      { scope: 'project', job: 'generate-asset', period: '2026-09-30', at: 'x' },
      {},
      'cost_cap_paused: project reached 90% of its budget',
    );
    const queue = new InlineJobQueue();
    const audits: string[] = [];
    const deps = {
      db,
      queue,
      logger: pino({ level: 'silent' }),
      audit: (e: { action: string }) => void audits.push(e.action),
      now: () => NOW,
    };
    const dry = await resumeCostPausedProjects(deps, { dryRun: true });
    expect(queue.history).toHaveLength(0);
    expect(dry.items.filter((i) => i.projectId === daily.id)[0]).toMatchObject({
      action: 'resumed',
    });

    const result = await resumeCostPausedProjects(deps);
    const item = (id: string) => result.items.find((i) => i.projectId === id);
    expect(item(daily.id)).toMatchObject({
      action: 'resumed',
      scope: 'org_daily',
      stage: 'assets',
    });
    expect(item(monthly.id)).toMatchObject({ action: 'resumed', stage: 'planning' });
    expect(item(today.id)).toMatchObject({
      action: 'skipped',
      reason: expect.stringMatching(/rolled over/),
    });
    expect(item(optedOut.id)).toMatchObject({
      action: 'skipped',
      reason: expect.stringMatching(/turned off/),
    });
    expect(item(budget.id)).toMatchObject({ action: 'skipped' });

    const after = await db.videoProject.findUniqueOrThrow({ where: { id: daily.id } });
    const meta = after.metadata as Record<string, unknown>;
    expect(after.state).toBe('ASSETS_QUEUED');
    expect(after.errorReason).toBeNull();
    expect(meta.costPause).toBeNull();
    expect(meta.autoResumed).toMatchObject({ scope: 'org_daily', period: '2026-09-30' });
    // Only the failed shot is generated again; the ready one is reused.
    const jobs = queue.history.filter((j) => j.data.projectId === daily.id).map((j) => j.name);
    expect(jobs).toEqual(['generate-asset']);
    expect(queue.history.find((j) => j.data.projectId === monthly.id)?.name).toBe('plan-project');
    expect((await db.videoProject.findUniqueOrThrow({ where: { id: monthly.id } })).state).toBe(
      'QUEUED',
    );
    expect(audits.filter((a) => a === 'studio.project.auto_resume')).toHaveLength(2);
    expect(
      await db.notification.count({
        where: { organisationId: org, dedupeKey: { startsWith: 'auto_resume:' } },
      }),
    ).toBe(2);

    // Resumed projects are no longer candidates.
    const again = await resumeCostPausedProjects(deps);
    expect(again.items.some((i) => i.projectId === daily.id)).toBe(false);
  });

  it('PATCH /projects/:id { autoResume } is allowed in any state and stored on the project', async () => {
    const project = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: 'biz',
        createdByUserId: 'user-1',
        name: 'Rendering now',
        state: 'RENDERING',
        sourceType: 'BRIEF',
        targetFormats: [],
      },
    });
    const res = await call(projectRoute.PATCH, {
      method: 'PATCH',
      token: 'owner',
      params: { id: project.id },
      body: { autoResume: false },
    });
    expect(res.status).toBe(200);
    expect((res.json.project as { metadata: Record<string, unknown> }).metadata.autoResume).toBe(
      false,
    );
    // Other fields still follow the editable-state rule.
    const blocked = await call(projectRoute.PATCH, {
      method: 'PATCH',
      token: 'owner',
      params: { id: project.id },
      body: { autoResume: true, name: 'Renamed' },
    });
    expect(blocked.status).toBe(409);
    const bad = await call(projectRoute.PATCH, {
      method: 'PATCH',
      token: 'owner',
      params: { id: project.id },
      body: { autoResume: 'yes' },
    });
    expect(bad.status).toBe(400);
    expect(api.audits.some((a) => a.action === 'studio.project.update')).toBe(true);
  });
});
