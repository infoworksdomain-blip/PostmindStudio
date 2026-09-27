import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flagKeys } from '../../src/lib/studio/system-flags';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import type { ProjectJobData } from '../../src/lib/studio/queue/queues';
import { createHarness, createProject, SCRIPT_JSON } from '../helpers/pipeline-harness';

// GATE 3 path, automated: brief → ideation → script → safety → shots → AI clips + voice →
// composition → S3 copy → probe → quality gate, on real Postgres with scripted providers.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('generation pipeline on real Postgres', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const organisationId = `pipeline-${randomUUID()}`;

  beforeAll(async () => {
    await db.systemFlag.deleteMany({
      where: { key: { startsWith: 'studio.frozenWorkspace.pipeline-' } },
    });
  });

  afterAll(async () => {
    const projects = await db.videoProject.findMany({
      where: { organisationId: { startsWith: 'pipeline-' } },
      select: { id: true },
    });
    const ids = projects.map((p) => p.id);
    await db.videoShot.deleteMany({ where: { script: { projectId: { in: ids } } } });
    await db.videoScript.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoBrief.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoAsset.deleteMany({ where: { projectId: { in: ids } } });
    await db.providerJob.deleteMany({ where: { organisationId: { startsWith: 'pipeline-' } } });
    await db.providerUsage.deleteMany({ where: { organisationId: { startsWith: 'pipeline-' } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.systemFlag.deleteMany({
      where: { key: { startsWith: 'studio.frozenWorkspace.pipeline-' } },
    });
    await db.$disconnect();
  });

  async function run(options: Parameters<typeof createHarness>[1] = {}, org = organisationId) {
    const h = createHarness(db, options);
    const { project, runId } = await createProject(db, { organisationId: org });
    const job: ProjectJobData = {
      projectId: project.id,
      organisationId: org,
      runId,
      planTier: 'STANDARD',
    };
    await h.queue.add('plan-project', job);
    const result = await drainInline(h.queue, h.deps);
    const after = await db.videoProject.findUniqueOrThrow({
      where: { id: project.id },
      include: {
        brief: true,
        scripts: { include: { shots: { orderBy: { sortOrder: 'asc' } } } },
        renders: true,
      },
    });
    return { h, project: after, result };
  }

  it('takes a brief all the way to READY_FOR_REVIEW', async () => {
    const { h, project, result } = await run();
    expect(result.failedJobs).toEqual([]);
    expect(project.state).toBe('READY_FOR_REVIEW');
    expect(project.completedAt).not.toBeNull();

    expect(project.brief).toMatchObject({
      hook: 'Still buying supermarket bread?',
      ideationModel: 'anthropic:scripted-claude',
    });
    const [script] = project.scripts;
    expect(script).toMatchObject({
      targetPlatform: 'tiktok',
      targetAspectRatio: '9:16',
      targetDurationSec: 15,
    });
    expect(script?.shots.map((s) => [s.visualTreatment, s.state])).toEqual([
      ['AI_CLIP', 'READY'],
      ['AI_CLIP', 'READY'],
      ['TEXT_CARD', 'READY'],
    ]);
    expect(script?.shots.reduce((sum, s) => sum + s.durationSec, 0)).toBeCloseTo(15, 5);
    expect(script?.shots[0]?.assetId).toBeTruthy();
    expect(script?.shots[0]?.voiceAssetId).toBeTruthy();
    expect(script?.shots[2]?.assetId).toBeNull(); // text cards are rendered by the composer

    // Runway output was copied into the assets bucket; Shotstack render into the renders bucket.
    expect([...h.objects.keys()].filter((k) => k.startsWith('assets/'))).toHaveLength(2);
    expect([...h.objects.keys()].filter((k) => k.startsWith('renders/'))).toHaveLength(1);

    expect(project.renders).toHaveLength(1);
    expect(project.renders[0]).toMatchObject({
      qualityCheckState: 'PASSED',
      resolution: '1080x1920',
      durationSec: 15,
      fps: 30,
    });
    const checks = project.renders[0]?.qualityIssues as Array<{ code: string; status: string }>;
    expect(checks.filter((c) => c.status === 'failed')).toEqual([]);
    expect(checks.find((c) => c.code === 'content_safety')?.status).toBe('passed');

    // Shotstack received an edit with one video clip per AI shot and narration.
    const edit = (
      h.adapters.shotstack.requests[0] as unknown as {
        edit: { timeline: { tracks: Array<{ clips: unknown[] }> } };
      }
    ).edit;
    expect(edit.timeline.tracks.length).toBeGreaterThanOrEqual(3);

    // Cost ledger: every provider call tracked and settled.
    const jobs = await db.providerJob.findMany({ where: { projectId: project.id } });
    expect(jobs.every((j) => j.state === 'SUCCEEDED')).toBe(true);
    expect(new Set(jobs.map((j) => j.provider))).toEqual(
      // assemblyai: narration is transcribed for word-level caption timing (13.6).
      new Set(['anthropic', 'runway', 'elevenlabs', 'assemblyai', 'shotstack', 'hive']),
    );
    expect(project.costActualPence).toBe(jobs.reduce((sum, j) => sum + j.costPence, 0));
  });

  it('stops before any asset spend when script safety says BLOCK', async () => {
    const { h, project } = await run({
      safety: { verdict: 'BLOCK', categories: ['financial_scam'], reason: 'guaranteed returns' },
    });
    expect(project.state).toBe('FAILED');
    expect(project.errorReason).toContain('script_safety_block');
    expect(project.scripts).toHaveLength(0);
    expect(h.adapters.runway.requests).toHaveLength(0);
  });

  it('returns vague briefs to DRAFT with three directions', async () => {
    const { project } = await run({
      ideation: {
        actionable: false,
        directionOptions: ['A', 'B', 'C'],
        hook: '',
        keyMessage: '',
        targetAudience: '',
        tone: '',
        callToAction: '',
        keywords: [],
        restrictedTopicsMentioned: [],
      },
    });
    expect(project.state).toBe('DRAFT');
    expect((project.metadata as { directionOptions: string[] }).directionOptions).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  it('fails the project with shot-level reasons when a clip cannot be generated', async () => {
    const { project, result } = await run({
      runwayRespond: () => ({
        state: 'failed',
        error: { class: 'content_policy', message: 'SAFETY.INPUT.TEXT', retryable: false },
      }),
    });
    expect(result.failedJobs.some((j) => j.startsWith('generate-asset__'))).toBe(true);
    expect(project.scripts[0]?.shots.filter((s) => s.state === 'FAILED')).toHaveLength(2);
    expect(project.state).toBe('FAILED');
    expect(project.errorReason).toContain('asset_generation_failed');
  });

  it('marks QUALITY_FAILED (force-approvable) when loudness is out of range', async () => {
    const { project } = await run({ loudness: -30 });
    expect(project.state).toBe('QUALITY_FAILED');
    expect(project.errorReason).toContain('audio_present');
    expect(project.renders[0]?.qualityCheckState).toBe('FAILED');
  });

  it('flags a content-safety BLOCK distinctly', async () => {
    const { project } = await run({ hiveMaxScores: { general_nsfw: 0.97 } });
    expect(project.state).toBe('QUALITY_FAILED');
    expect(project.errorReason).toContain('content_safety_block');
  });

  it('honours a workspace freeze: the run fails without calling providers', async () => {
    const org = `pipeline-frozen-${randomUUID()}`;
    await db.systemFlag.create({ data: { key: flagKeys.workspace(org), value: 'true' } });
    const { h, project, result } = await run({}, org);
    expect(result.failedJobs).toHaveLength(1);
    expect(project.state).toBe('FAILED');
    expect(project.errorReason).toContain('kill_switch_workspace');
    expect(h.adapters.anthropic.requests).toHaveLength(0);
  });

  it('ignores jobs from a superseded run', async () => {
    const h = createHarness(db);
    const { project } = await createProject(db, { organisationId });
    await h.queue.add('plan-project', {
      projectId: project.id,
      organisationId,
      runId: 'old-run',
      planTier: 'STANDARD',
    });
    await drainInline(h.queue, h.deps);
    expect((await db.videoProject.findUniqueOrThrow({ where: { id: project.id } })).state).toBe(
      'QUEUED',
    );
    expect(h.adapters.anthropic.requests).toHaveLength(0);
  });

  it('re-planning replaces the previous plan', async () => {
    const h = createHarness(db, {
      script: { ...SCRIPT_JSON, shots: SCRIPT_JSON.shots.slice(0, 2) },
    });
    const { project, runId } = await createProject(db, { organisationId });
    const job: ProjectJobData = {
      projectId: project.id,
      organisationId,
      runId,
      planTier: 'STANDARD',
    };
    await h.queue.add('plan-project', job);
    await drainInline(h.queue, h.deps);
    const newRun = randomUUID();
    await db.videoProject.update({
      where: { id: project.id },
      data: { state: 'QUEUED', metadata: { runId: newRun } },
    });
    await h.queue.add('plan-project', { ...job, runId: newRun });
    await drainInline(h.queue, h.deps);
    const scripts = await db.videoScript.findMany({
      where: { projectId: project.id },
      include: { shots: true },
    });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.shots).toHaveLength(2);
  });
});
