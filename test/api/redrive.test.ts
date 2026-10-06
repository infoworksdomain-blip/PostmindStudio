import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma, type ShotState, type VideoProjectState } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as redriveRoute from '../../src/app/api/studio/admin/redrive/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { flagKeys } from '../../src/lib/studio/system-flags';
import { call, installApi, tenant } from '../helpers/api-harness';

// POST /api/studio/admin/redrive (services/redrive.ts): dry run vs apply, resume from the killed
// stage without touching finished shots, publication retry, stuck re-enqueue under the current
// run, filters, validation, the staff guard and the audit event. Rows are seeded directly so each
// case controls the exact state the kill switch left behind.

const hasDb = Boolean(process.env.DATABASE_URL);
const CAPS = ['studio:admin:redrive'];
const HOUR = 3_600_000;

type Item = {
  kind: string;
  id: string;
  organisationId: string;
  action: string;
  jobs?: string[];
  skippedReason?: string;
};

describe.skipIf(!hasDb)('admin re-drive API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const run = randomUUID().slice(0, 8);
  const staffOrg = `api-redrive-staff-${run}`;
  const orgA = `api-redrive-a-${run}`;
  const orgB = `api-redrive-b-${run}`;
  const tokens = {
    staff: tenant(staffOrg, CAPS),
    killSwitchOnly: tenant(staffOrg, ['studio:admin:kill-switch:write']),
    outsider: tenant(`api-redrive-out-${run}`, CAPS),
  };
  let api: ReturnType<typeof installApi>;
  const since = () => new Date(Date.now() - HOUR).toISOString();

  beforeEach(() => {
    api = installApi(db, tokens);
    vi.stubEnv('STUDIO_PLATFORM_ORG_IDS', staffOrg);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await cleanup();
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.$disconnect();
  });

  async function cleanup() {
    const org = { in: [orgA, orgB] };
    const projects = (
      await db.videoProject.findMany({ where: { organisationId: org }, select: { id: true } })
    ).map((p) => p.id);
    await db.videoPublication.deleteMany({ where: { projectId: { in: projects } } });
    await db.videoRender.deleteMany({ where: { projectId: { in: projects } } });
    await db.videoShot.deleteMany({ where: { script: { projectId: { in: projects } } } });
    await db.videoScript.deleteMany({ where: { projectId: { in: projects } } });
    await db.videoProject.deleteMany({ where: { id: { in: projects } } });
    await db.systemFlag.deleteMany({ where: { key: { contains: run } } });
  }

  const post = (body: Record<string, unknown>, token = 'staff') =>
    call(redriveRoute.POST, { method: 'POST', token, body });

  async function seedProject(input: {
    organisationId: string;
    state: VideoProjectState;
    errorReason?: string | null;
    shots?: Array<{ state: ShotState; errorReason?: string; assetId?: string | null }>;
    metadata?: Record<string, unknown>;
    sourceType?: 'BRIEF' | 'SLIDESHOW';
  }) {
    const runId = randomUUID();
    const project = await db.videoProject.create({
      data: {
        organisationId: input.organisationId,
        businessId: 'biz-1',
        createdByUserId: 'user-1',
        name: 'Re-drive fixture',
        state: input.state,
        sourceType: input.sourceType ?? 'BRIEF',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 15 }],
        errorReason: input.errorReason ?? null,
        metadata: (input.metadata ?? {
          runId,
          planTier: 'PLUS',
          renders: {},
        }) as Prisma.InputJsonValue,
      },
    });
    const script = await db.videoScript.create({
      data: {
        projectId: project.id,
        targetPlatform: 'tiktok',
        targetAspectRatio: '9:16',
        targetDurationSec: 15,
        fullText: 'text',
        scriptModel: 'scripted',
      },
    });
    const shots = [];
    for (const [i, shot] of (input.shots ?? []).entries()) {
      shots.push(
        await db.videoShot.create({
          data: {
            scriptId: script.id,
            sortOrder: i,
            durationSec: 5,
            visualTreatment: 'AI_CLIP',
            sceneDescription: `shot ${i}`,
            state: shot.state,
            errorReason: shot.errorReason ?? null,
            assetId: shot.assetId ?? null,
          },
        }),
      );
    }
    return { project, runId, shots };
  }

  async function seedPublication(
    projectId: string,
    organisationId: string,
    errorReason: string,
    metadata: Record<string, unknown> = {},
  ) {
    const render = await db.videoRender.create({
      data: {
        projectId,
        scriptId: 'script',
        targetPlatform: 'tiktok',
        aspectRatio: '9:16',
        resolution: '1080x1920',
        durationSec: 15,
        fps: 30,
        bitrateKbps: 4500,
        s3Bucket: 'renders',
        s3Key: `k-${randomUUID()}`,
        qualityCheckState: 'PASSED',
      },
    });
    return db.videoPublication.create({
      data: {
        organisationId,
        projectId,
        renderId: render.id,
        platform: 'tiktok',
        platformAccountId: 'acct',
        state: 'FAILED',
        errorReason,
        retryCount: 1,
        hashtags: [],
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }

  const KILLED_SHOT = 'kill_switch_workspace: Studio kill switch active (workspace)';

  async function seedKilledWorld() {
    const assets = await seedProject({
      organisationId: orgA,
      state: 'FAILED',
      errorReason: `composition_failed: ${KILLED_SHOT}`,
      shots: [
        { state: 'READY', assetId: 'asset-1' },
        { state: 'READY', assetId: 'asset-2' },
        { state: 'FAILED', errorReason: KILLED_SHOT },
      ],
    });
    const planning = await seedProject({
      organisationId: orgA,
      state: 'FAILED',
      errorReason: `planning_failed: ${KILLED_SHOT}`,
    });
    const mixed = await seedProject({
      organisationId: orgA,
      state: 'FAILED',
      errorReason: `asset_generation_failed: shot 1: runway/content_policy: no; shot 2: ${KILLED_SHOT}`,
      shots: [
        { state: 'FAILED', errorReason: 'runway/content_policy: no' },
        { state: 'FAILED', errorReason: KILLED_SHOT },
      ],
    });
    const noTier = await seedProject({
      organisationId: orgA,
      state: 'FAILED',
      errorReason: `planning_failed: ${KILLED_SHOT}`,
      metadata: { runId: randomUUID() },
    });
    const cancelled = await seedProject({
      organisationId: orgA,
      state: 'FAILED',
      errorReason: 'cancelled_by_user',
    });
    const published = await seedProject({ organisationId: orgA, state: 'PARTIALLY_PUBLISHED' });
    const pub = await seedPublication(
      published.project.id,
      orgA,
      'kill_switch_platform: Studio kill switch active (platform)',
    );
    const unsure = await seedPublication(
      published.project.id,
      orgA,
      'kill_switch_platform: Studio kill switch active (platform)',
      { uploadStartedAt: new Date().toISOString() },
    );
    return { assets, planning, mixed, noTier, cancelled, published, pub, unsure };
  }

  const byId = (items: Item[]) => new Map(items.map((i) => [i.id, i]));

  it('dry run: plans each resume, reports skips, and changes nothing', async () => {
    const w = await seedKilledWorld();
    const res = await post({ scope: 'kill_switch', since: since(), organisationId: orgA });
    expect(res.status).toBe(200);
    expect(res.json.dryRun).toBe(true);
    const items = byId(res.json.items as Item[]);
    expect(items.get(w.assets.project.id)).toMatchObject({
      action: 'resume_assets',
      jobs: ['generate-asset'],
    });
    expect(items.get(w.planning.project.id)).toMatchObject({
      action: 'resume_planning',
      jobs: ['plan-project'],
    });
    expect(items.get(w.mixed.project.id)?.skippedReason).toContain('other than the kill switch');
    expect(items.get(w.noTier.project.id)?.skippedReason).toContain('plan tier');
    expect(items.has(w.cancelled.project.id)).toBe(false);
    expect(items.get(w.pub.id)).toMatchObject({ action: 'retry_publication' });
    expect(items.get(w.unsure.id)?.skippedReason).toContain('upload outcome unknown');
    expect(res.json.counts).toEqual({ considered: 6, redriven: 3, skipped: 3 });

    expect(api.queue.pending).toHaveLength(0);
    const after = await db.videoProject.findUniqueOrThrow({ where: { id: w.assets.project.id } });
    expect(after.state).toBe('FAILED');
    expect(after.updatedAt).toEqual(w.assets.project.updatedAt);
    expect((await db.videoPublication.findUniqueOrThrow({ where: { id: w.pub.id } })).state).toBe(
      'FAILED',
    );
    const audit = api.audits.find((a) => a.action === 'studio.redrive.run');
    expect(audit?.metadata).toMatchObject({
      dryRun: true,
      counts: { considered: 6, redriven: 3, skipped: 3 },
      filter: { scope: 'kill_switch', organisationId: orgA },
    });
  });

  it('apply: resumes from the killed stage, keeping finished shots, and is idempotent', async () => {
    const w = await seedKilledWorld();
    const res = await post({
      scope: 'kill_switch',
      since: since(),
      organisationId: orgA,
      dryRun: false,
    });
    expect(res.status).toBe(200);
    expect(res.json.counts).toMatchObject({ redriven: 3, skipped: 3 });

    const assets = await db.videoProject.findUniqueOrThrow({ where: { id: w.assets.project.id } });
    const meta = assets.metadata as { runId: string; redrivenFrom: string; planTier: string };
    expect(assets.state).toBe('ASSETS_QUEUED');
    expect(assets.errorReason).toBeNull();
    expect(meta.runId).not.toBe(w.assets.runId);
    expect(meta.redrivenFrom).toBe(w.assets.runId);
    const shots = await db.videoShot.findMany({
      where: { id: { in: w.assets.shots.map((s) => s.id) } },
      orderBy: { sortOrder: 'asc' },
    });
    expect(shots.map((s) => [s.state, s.assetId])).toEqual([
      ['READY', 'asset-1'],
      ['READY', 'asset-2'],
      ['QUEUED', null],
    ]);
    const jobs = api.queue.pending.map((j) => ({ name: j.name, data: j.data }));
    expect(jobs).toContainEqual({
      name: 'generate-asset',
      data: expect.objectContaining({
        shotId: w.assets.shots[2]?.id,
        runId: meta.runId,
        planTier: 'PLUS',
      }),
    });
    expect(jobs.filter((j) => j.name === 'generate-asset')).toHaveLength(1);

    const planning = await db.videoProject.findUniqueOrThrow({
      where: { id: w.planning.project.id },
    });
    expect(planning.state).toBe('QUEUED');
    expect(jobs).toContainEqual({
      name: 'plan-project',
      data: expect.objectContaining({ projectId: w.planning.project.id }),
    });

    const pub = await db.videoPublication.findUniqueOrThrow({ where: { id: w.pub.id } });
    expect(pub.state).toBe('SCHEDULED');
    expect(jobs.filter((j) => j.name === 'publish-video')).toHaveLength(1);
    expect(
      (await db.videoPublication.findUniqueOrThrow({ where: { id: w.unsure.id } })).state,
    ).toBe('FAILED');
    expect(
      (await db.videoProject.findUniqueOrThrow({ where: { id: w.mixed.project.id } })).state,
    ).toBe('FAILED');

    // A second run finds only the items it skipped before.
    const again = await post({
      scope: 'kill_switch',
      since: since(),
      organisationId: orgA,
      dryRun: false,
    });
    expect(again.json.counts).toEqual({ considered: 3, redriven: 0, skipped: 3 });
  });

  it('skips work the kill switch still blocks, and honours the level filter', async () => {
    const frozenOrg = `${orgB}`;
    await db.systemFlag.upsert({
      where: { key: flagKeys.workspace(frozenOrg) },
      create: { key: flagKeys.workspace(frozenOrg), value: 'true' },
      update: { value: 'true' },
    });
    const frozen = await seedProject({
      organisationId: frozenOrg,
      state: 'FAILED',
      errorReason: `planning_failed: ${KILLED_SHOT}`,
    });
    try {
      const res = await post({ scope: 'kill_switch', since: since(), organisationId: frozenOrg });
      expect(byId(res.json.items as Item[]).get(frozen.project.id)?.skippedReason).toBe(
        'kill_switch_still_engaged: workspace',
      );
      const platformOnly = await post({
        scope: 'kill_switch',
        since: since(),
        organisationId: frozenOrg,
        level: 'platform',
      });
      expect(platformOnly.json.items).toEqual([]);
    } finally {
      await db.systemFlag.deleteMany({ where: { key: flagKeys.workspace(frozenOrg) } });
    }
  });

  it('stuck: re-enqueues the current stage under the current run, only past the threshold', async () => {
    const rendering = await seedProject({ organisationId: orgA, state: 'RENDERING' });
    const generating = await seedProject({
      organisationId: orgA,
      state: 'ASSETS_GENERATING',
      shots: [{ state: 'READY', assetId: 'asset-1' }, { state: 'QUEUED' }],
    });
    const fresh = await seedProject({ organisationId: orgA, state: 'QUALITY_CHECKING' });
    const old = new Date(Date.now() - 2 * HOUR);
    await db.$executeRaw`UPDATE studio.video_projects SET "updatedAt" = ${old} WHERE id IN (${rendering.project.id}, ${generating.project.id})`;

    const dry = await post({ scope: 'stuck', organisationId: orgA, stuckMinutes: 60 });
    expect(dry.status).toBe(200);
    const planned = byId(dry.json.items as Item[]);
    expect(planned.get(rendering.project.id)).toMatchObject({
      action: 'reenqueue',
      jobs: ['compose-video'],
    });
    expect(planned.get(generating.project.id)).toMatchObject({ jobs: ['generate-asset'] });
    expect(planned.has(fresh.project.id)).toBe(false);
    expect(api.queue.pending).toHaveLength(0);

    await post({ scope: 'stuck', organisationId: orgA, stuckMinutes: 60, dryRun: false });
    const jobs = api.queue.pending;
    // 23.6: a RENDERING run also gets a fresh render poll chain (a no-op with nothing pending).
    expect(jobs.map((j) => j.name).sort()).toEqual([
      'compose-video',
      'generate-asset',
      'poll-render',
    ]);
    expect(jobs.find((j) => j.name === 'compose-video')?.data).toMatchObject({
      projectId: rendering.project.id,
      runId: rendering.runId,
    });
    expect(jobs.find((j) => j.name === 'generate-asset')?.data).toMatchObject({
      shotId: generating.shots[1]?.id,
      runId: generating.runId,
    });
    // Same run, same job ids: a second apply adds nothing.
    await post({ scope: 'stuck', organisationId: orgA, stuckMinutes: 60, dryRun: false });
    expect(api.queue.pending).toHaveLength(3);
    expect(
      (await db.videoProject.findUniqueOrThrow({ where: { id: rendering.project.id } })).state,
    ).toBe('RENDERING');
  });

  it('validates input', async () => {
    expect((await post({ scope: 'kill_switch' })).status).toBe(400);
    const tooOld = new Date(Date.now() - 31 * 24 * HOUR).toISOString();
    expect((await post({ scope: 'kill_switch', since: tooOld })).status).toBe(400);
    expect((await post({ scope: 'stuck', limit: 501 })).status).toBe(400);
    expect((await post({ scope: 'stuck', stuckMinutes: 5 })).status).toBe(400);
    expect((await post({ scope: 'stuck', level: 'global' })).status).toBe(400);
    expect((await post({ scope: 'everything' })).status).toBe(400);
  });

  it('is staff only and needs the re-drive capability', async () => {
    expect((await post({ scope: 'stuck' }, 'outsider')).status).toBe(403);
    expect((await post({ scope: 'stuck' }, 'killSwitchOnly')).status).toBe(403);
    expect(api.audits.filter((a) => a.action === 'studio.redrive.run')).toHaveLength(0);
  });
});
