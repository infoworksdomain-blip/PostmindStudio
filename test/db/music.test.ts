import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import type { PlanTier } from '../../src/lib/studio/providers/router';
import { createProviderRegistry } from '../../src/lib/studio/providers/registry';
import type { ProjectJobData } from '../../src/lib/studio/queue/queues';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import { createHarness, createProject, SCRIPT_JSON } from '../helpers/pipeline-harness';
import { musicDouble } from '../helpers/music-double';

// Layer 5 on real Postgres: one ElevenLabs Music track per run (scripted double with the real
// adapter's output shape), reused on re-render, non-fatal on failure, off for BASIC.

const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = `music-${randomUUID().slice(0, 8)}`;

type EditTrack = { clips: Array<{ asset: { type: string; src?: string; volume?: number } }> };

describe.skipIf(!hasDb)('Layer 5 music on real Postgres', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);

  afterAll(async () => {
    const ids = (
      await db.videoProject.findMany({
        where: { organisationId: { startsWith: PREFIX } },
        select: { id: true },
      })
    ).map((p) => p.id);
    await db.videoShot.deleteMany({ where: { script: { projectId: { in: ids } } } });
    await db.videoScript.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoBrief.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoAsset.deleteMany({ where: { projectId: { in: ids } } });
    await db.providerJob.deleteMany({ where: { organisationId: { startsWith: PREFIX } } });
    await db.providerUsage.deleteMany({ where: { organisationId: { startsWith: PREFIX } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  async function run(
    planTier: PlanTier,
    music = musicDouble(),
    options: Parameters<typeof createHarness>[1] = {},
  ) {
    const h = createHarness(db, options);
    h.deps.registry = createProviderRegistry([...h.deps.registry.list(), music]);
    const org = `${PREFIX}-${randomUUID().slice(0, 6)}`;
    const { project, runId } = await createProject(db, { organisationId: org });
    const job: ProjectJobData = { projectId: project.id, organisationId: org, runId, planTier };
    await h.queue.add('plan-project', job);
    const result = await drainInline(h.queue, h.deps);
    expect(result.failedJobs).toEqual([]);
    const after = await db.videoProject.findUniqueOrThrow({ where: { id: project.id } });
    return { h, music, job, project: after };
  }

  const musicMeta = (metadata: unknown) => (metadata as { music?: Record<string, unknown> }).music;
  const lastEditTracks = (h: ReturnType<typeof createHarness>) => {
    const request = h.adapters.shotstack.requests.at(-1);
    if (request?.capability !== 'composition') throw new Error('no composition request');
    return (request.edit as { timeline: { tracks: EditTrack[] } }).timeline.tracks;
  };

  it('generates one instrumental track sized to the video and mixes it under narration', async () => {
    const { h, music, project } = await run('STANDARD');
    expect(project.state).toBe('READY_FOR_REVIEW');
    expect(music.requests).toHaveLength(1);
    const request = music.requests[0];
    expect(request).toMatchObject({ capability: 'music', durationSec: 15 });
    if (request?.capability !== 'music') throw new Error('expected music');
    expect(request.prompt).toContain('no vocals');
    expect(request.prompt).toContain('warm, confident'); // IDEATION_JSON tone

    const assets = await db.videoAsset.findMany({
      where: { projectId: project.id, kind: 'AUDIO_MUSIC' },
    });
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      shotId: null,
      source: 'elevenlabs-music:music_v2_5',
      durationSec: 15,
      costPence: 3,
    });
    expect(musicMeta(project.metadata)).toMatchObject({
      status: 'generated',
      assetId: assets[0]?.id,
      providerId: 'elevenlabs-music',
      reused: false,
    });
    const job = await db.providerJob.findFirstOrThrow({
      where: { projectId: project.id, provider: 'elevenlabs-music' },
    });
    expect(job.costPence).toBe(3);

    const audio = lastEditTracks(h).at(-1)?.clips[0]?.asset;
    expect(audio).toMatchObject({ type: 'audio', volume: 0.2, effect: 'fadeOut' });
    expect(audio?.src).toContain(assets[0]?.s3Key);
  });

  it('reuses the track on a re-render instead of paying again', async () => {
    const { h, music, job, project } = await run('STANDARD');
    const runId = randomUUID();
    await db.videoProject.update({
      where: { id: project.id },
      data: {
        state: 'ASSETS_QUEUED',
        metadata: { ...(project.metadata as object), runId, renders: {} },
      },
    });
    await h.queue.add('compose-video', { ...job, runId });
    const result = await drainInline(h.queue, h.deps);
    expect(result.failedJobs).toEqual([]);
    const after = await db.videoProject.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.state).toBe('READY_FOR_REVIEW');
    expect(music.requests).toHaveLength(1);
    expect(musicMeta(after.metadata)).toMatchObject({ status: 'generated', reused: true, runId });
    expect(
      await db.videoAsset.count({ where: { projectId: project.id, kind: 'AUDIO_MUSIC' } }),
    ).toBe(1);
    expect(lastEditTracks(h).at(-1)?.clips[0]?.asset.type).toBe('audio');
  });

  it('a music failure is non-fatal: the video renders with narration only', async () => {
    const failing = musicDouble(() => ({
      state: 'failed',
      error: { class: 'content_policy', message: 'bad_prompt: refused', retryable: false },
    }));
    const { h, project } = await run('STANDARD', failing);
    expect(project.state).toBe('READY_FOR_REVIEW');
    expect(musicMeta(project.metadata)).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('content_policy'),
    });
    const tracks = lastEditTracks(h);
    const audioSrcs = tracks.flatMap((t) => t.clips).filter((c) => c.asset.type === 'audio');
    expect(audioSrcs.length).toBeGreaterThan(0); // narration still there
    expect(audioSrcs.every((c) => c.asset.volume === 1)).toBe(true); // no music bed
  });

  it('no music provider configured is recorded as failed, not faked', async () => {
    const h = createHarness(db);
    const org = `${PREFIX}-none`;
    const { project, runId } = await createProject(db, { organisationId: org });
    await h.queue.add('plan-project', {
      projectId: project.id,
      organisationId: org,
      runId,
      planTier: 'PLUS',
    });
    expect((await drainInline(h.queue, h.deps)).failedJobs).toEqual([]);
    const after = await db.videoProject.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.state).toBe('READY_FOR_REVIEW');
    expect(musicMeta(after.metadata)).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('No provider available for music'),
    });
  });

  it('BASIC plans stay narration-only (spec 12.4) and never call the provider', async () => {
    // BASIC routes AI clips to Fal/Replicate (not in the harness), so use text cards only.
    const textOnly = {
      ...SCRIPT_JSON,
      shots: SCRIPT_JSON.shots.map((shot) => ({ ...shot, visualTreatment: 'TEXT_CARD' })),
    };
    const { music, project } = await run('BASIC', musicDouble(), { script: textOnly });
    expect(project.state).toBe('READY_FOR_REVIEW');
    expect(music.requests).toHaveLength(0);
    expect(musicMeta(project.metadata)).toMatchObject({ status: 'off_for_plan' });
  });
});
