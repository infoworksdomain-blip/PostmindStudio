import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import type { ProviderPollResult } from '../../src/lib/studio/providers/interface';
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

  describe('23.1 music library', () => {
    const libraryKeys = new Set<string>();
    afterAll(async () => {
      await db.musicLibraryTrack.deleteMany({ where: { promptKey: { in: [...libraryKeys] } } });
    });

    /** One harness (one storage) for every video, with the library on at `size` tracks a key. */
    async function libraryHarness(size: number) {
      const h = createHarness(db);
      // Like the real adapter, the double stores the generated file (the library copies it).
      const stored = musicDouble();
      const music = musicDouble((request) => {
        const result = stored.respond(request) as ProviderPollResult;
        const meta = result.output?.metadata as { s3Bucket: string; s3Key: string };
        h.objects.set(`${meta.s3Bucket}/${meta.s3Key}`, {
          body: new Uint8Array([0x49, 0x44, 0x33]),
          contentType: 'audio/mpeg',
        });
        return result;
      });
      h.deps.registry = createProviderRegistry([...h.deps.registry.list(), music]);
      h.deps.config = { ...h.deps.config, musicLibrary: { enabled: true, size } };
      const video = async () => {
        const org = `${PREFIX}-lib-${randomUUID().slice(0, 6)}`;
        const { project, runId } = await createProject(db, { organisationId: org });
        const job: ProjectJobData = {
          projectId: project.id,
          organisationId: org,
          runId,
          planTier: 'STANDARD',
        };
        await h.queue.add('plan-project', job);
        expect((await drainInline(h.queue, h.deps)).failedJobs).toEqual([]);
        const after = await db.videoProject.findUniqueOrThrow({ where: { id: project.id } });
        expect(after.state).toBe('READY_FOR_REVIEW');
        const meta = musicMeta(after.metadata) ?? {};
        if (typeof meta.promptKey === 'string') libraryKeys.add(meta.promptKey);
        return { project: after, job, meta };
      };
      // Earlier runs of this suite may have left tracks for the fixture's prompt key.
      const clear = async (promptKey: string) =>
        db.musicLibraryTrack.deleteMany({ where: { promptKey } });
      return { h, music, video, clear };
    }

    it(
      'generates until the key has N tracks, then reuses them in rotation at no cost',
      { timeout: 240_000 },
      async () => {
        const lib = await libraryHarness(2);
        const first = await lib.video();
        const key = String(first.meta.promptKey);
        // Start from an empty library for this key (the first video may have reused a leftover).
        await lib.clear(key);
        const callsBefore = lib.music.requests.length;

        const a = await lib.video();
        const b = await lib.video();
        expect(lib.music.requests.length - callsBefore).toBe(2);
        expect(a.meta).toMatchObject({ status: 'generated', reused: false });
        expect(b.meta).toMatchObject({ status: 'generated', reused: false });
        const tracks = await db.musicLibraryTrack.findMany({ where: { promptKey: key } });
        expect(tracks).toHaveLength(2);
        expect(tracks.every((t) => t.s3Key.startsWith(`music-library/${key}/`))).toBe(true);
        expect(tracks.map((t) => t.bucketSec)).toEqual([15, 15]);

        const c = await lib.video();
        const d = await lib.video();
        expect(lib.music.requests.length - callsBefore).toBe(2); // no new ElevenLabs call
        for (const reused of [c, d]) {
          expect(reused.meta).toMatchObject({
            status: 'reused',
            reused: true,
            providerId: 'music-library',
            costPence: 0,
          });
          const asset = await db.videoAsset.findFirstOrThrow({
            where: { projectId: reused.project.id, kind: 'AUDIO_MUSIC' },
          });
          expect(asset).toMatchObject({ costPence: 0, providerJobId: null });
          expect(
            await db.providerJob.count({
              where: { projectId: reused.project.id, provider: 'elevenlabs-music' },
            }),
          ).toBe(0);
          // The reused bed is the library object, laid under the edit as before.
          const audio = lastEditTracks(lib.h).at(-1)?.clips[0]?.asset;
          expect(audio?.type).toBe('audio');
        }
        // Rotation: the two videos got different tracks (least recently used first).
        expect(c.meta.libraryTrackId).not.toBe(d.meta.libraryTrackId);
        expect(new Set([c.meta.libraryTrackId, d.meta.libraryTrackId])).toEqual(
          new Set(tracks.map((t) => t.id)),
        );
      },
    );

    it("a re-render keeps the project's own track before the library (and pays nothing)", async () => {
      const lib = await libraryHarness(1);
      const { project, job, meta } = await lib.video();
      const calls = lib.music.requests.length;
      const runId = randomUUID();
      await db.videoProject.update({
        where: { id: project.id },
        data: {
          state: 'ASSETS_QUEUED',
          metadata: { ...(project.metadata as object), runId, renders: {} },
        },
      });
      await lib.h.queue.add('compose-video', { ...job, runId });
      expect((await drainInline(lib.h.queue, lib.h.deps)).failedJobs).toEqual([]);
      const after = await db.videoProject.findUniqueOrThrow({ where: { id: project.id } });
      expect(lib.music.requests.length).toBe(calls);
      expect(musicMeta(after.metadata)).toMatchObject({ reused: true, assetId: meta.assetId });
      expect(
        await db.videoAsset.count({ where: { projectId: project.id, kind: 'AUDIO_MUSIC' } }),
      ).toBe(1);
    });

    it('a library track whose object is gone is dropped and a new one generated', async () => {
      const lib = await libraryHarness(1);
      const first = await lib.video();
      const key = String(first.meta.promptKey);
      await lib.clear(key);
      await db.musicLibraryTrack.create({
        data: {
          promptKey: key,
          bucketSec: 15,
          durationSec: 15,
          s3Bucket: 'assets',
          s3Key: `music-library/${key}/${randomUUID()}.mp3`, // never stored
          source: 'elevenlabs-music:music_v2_5',
        },
      });
      const calls = lib.music.requests.length;
      const next = await lib.video();
      expect(lib.music.requests.length).toBe(calls + 1);
      expect(next.meta).toMatchObject({ status: 'generated', reused: false });
      const tracks = await db.musicLibraryTrack.findMany({ where: { promptKey: key } });
      expect(tracks).toHaveLength(1);
      expect(tracks[0]?.id).toBe(next.meta.libraryTrackId);
    });

    it("a BYOC organisation's own-key generations never join the shared library", async () => {
      const lib = await libraryHarness(5);
      lib.h.deps.registryFor = async () => lib.h.deps.registry;
      const first = await lib.video();
      const key = String(first.meta.promptKey);
      await lib.clear(key);
      const next = await lib.video();
      expect(next.meta).toMatchObject({ status: 'generated' });
      expect(next.meta.libraryTrackId).toBeUndefined();
      expect(await db.musicLibraryTrack.count({ where: { promptKey: key } })).toBe(0);
    });

    it(
      '25.x: ElevenLabs Music rate-limited → a library track is laid under the video, never silent',
      { timeout: 240_000 },
      async () => {
        const lib = await libraryHarness(5);
        const first = await lib.video(); // generates, and adds its track to the library
        const key = String(first.meta.promptKey);
        expect(first.meta.libraryTrackId).toBeTruthy();
        // The production refusal (2026-10-07), for every music request from now on.
        const limited = musicDouble(() => ({
          state: 'failed',
          error: {
            class: 'rate_limited',
            message: 'too_many_concurrent_requests: maximum of 2 concurrent requests for your plan',
            retryable: true,
          },
        }));
        lib.h.deps.registry = createProviderRegistry([
          ...lib.h.deps.registry.list().filter((a) => a.providerId !== 'elevenlabs-music'),
          limited,
        ]);
        const next = await lib.video();
        expect(limited.requests).toHaveLength(1);
        expect(next.meta).toMatchObject({
          status: 'reused',
          reused: true,
          providerId: 'music-library',
          libraryTrackId: first.meta.libraryTrackId,
          costPence: 0,
          promptKey: key,
          fallbackFrom: expect.stringContaining('rate_limited'),
        });
        const asset = await db.videoAsset.findFirstOrThrow({
          where: { projectId: next.project.id, kind: 'AUDIO_MUSIC' },
        });
        expect(asset).toMatchObject({ costPence: 0, providerJobId: null, fingerprint: key });
        // No music cost for the refused request (only generated tracks are paid for).
        const jobs = await db.providerJob.findMany({
          where: { projectId: next.project.id, provider: 'elevenlabs-music' },
        });
        expect(jobs.reduce((t, j) => t + j.costPence, 0)).toBe(0);
        // The render has its music bed (the library object), not narration alone.
        const bed = lastEditTracks(lib.h).at(-1)?.clips[0]?.asset;
        expect(bed?.type).toBe('audio');
        expect(bed?.src).toContain(`music-library/${key}/`);

        // A retry of the same run keeps that track: no second pick, no second asset.
        await lib.h.queue.add('compose-video', next.job);
        expect((await drainInline(lib.h.queue, lib.h.deps)).failedJobs).toEqual([]);
        expect(
          await db.videoAsset.count({ where: { projectId: next.project.id, kind: 'AUDIO_MUSIC' } }),
        ).toBe(1);
        expect(limited.requests).toHaveLength(1);
      },
    );

    it('25.x: with an empty library a failed generation still renders without music', async () => {
      const lib = await libraryHarness(5);
      const first = await lib.video();
      libraryKeys.add(String(first.meta.promptKey));
      for (const key of libraryKeys) await lib.clear(key);
      const empty = (await db.musicLibraryTrack.count()) === 0;
      const refused = musicDouble(() => ({
        state: 'failed',
        error: { class: 'provider_unavailable', message: 'service down', retryable: true },
      }));
      lib.h.deps.registry = createProviderRegistry([
        ...lib.h.deps.registry.list().filter((a) => a.providerId !== 'elevenlabs-music'),
        refused,
      ]);
      // Only this suite adds library tracks; with them cleared the library is empty (unless the
      // database holds tracks from elsewhere, which the relaxed pick would then use).
      const next = await lib.video();
      if (empty) {
        expect(next.meta).toMatchObject({
          status: 'failed',
          reason: expect.stringContaining('provider_unavailable'),
        });
        const audio = lastEditTracks(lib.h)
          .flatMap((t) => t.clips)
          .filter((c) => c.asset.type === 'audio');
        expect(audio.every((c) => c.asset.volume === 1)).toBe(true); // narration only
      } else {
        expect(next.meta).toMatchObject({
          status: 'reused',
          fallbackFrom: expect.stringContaining('provider_unavailable'),
        });
      }
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
