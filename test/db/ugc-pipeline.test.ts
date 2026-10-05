import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '../../src/lib/tenant';
import { UGC_HOOK_ANCHOR_Y } from '../../src/lib/studio/overlays/suggest';
import type { ActorVideoRequest } from '../../src/lib/studio/providers/interface';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import type { ProjectJobData } from '../../src/lib/studio/queue/queues';
import { regenerateShot } from '../../src/lib/studio/services/shots';
import {
  ACTOR_PORTRAIT_ROLE,
  actorImageOf,
  actorPortraitPrompt,
} from '../../src/lib/studio/ugc/portrait';
import { actorDescription, newUgcStyle } from '../../src/lib/studio/ugc/style';
import { createHarness, createProject, IDEATION_JSON } from '../helpers/pipeline-harness';

// BACKLOG 21.4 — a UGC actor video through the real pipeline on real Postgres with scripted
// providers: UGC ideation + script, actor clips from (scripted) Veo with the line, seed and actor
// description, no ElevenLabs voice for actor shots, clip transcription for captions, the clip's
// own audio in the edit, the AI label, and audio_sync / caption_sync on clip speech. Then the
// real-person refusal at ideation, and the degrade path when no actor provider is available.

const hasDb = Boolean(process.env.DATABASE_URL);

const UGC_SCRIPT = {
  fullText: 'Mornings used to be chaos. This kit fixed that. Try it.',
  shots: [
    {
      durationSec: 6,
      visualTreatment: 'UGC_ACTOR',
      beat: 'hook',
      sceneDescription: 'holds the jar up to the phone and smiles',
      cameraDirection: 'close selfie',
      voiceoverText: 'Mornings used to be chaos.',
      onScreenText: '',
      transitionOut: 'cut',
    },
    {
      durationSec: 3,
      visualTreatment: 'TEXT_CARD',
      beat: 'demo',
      sceneDescription: 'card',
      cameraDirection: '',
      voiceoverText: 'Two minutes, done.',
      onScreenText: '',
      transitionOut: 'cut',
    },
    {
      durationSec: 6,
      visualTreatment: 'UGC_ACTOR',
      beat: 'cta',
      sceneDescription: 'points at the camera',
      cameraDirection: 'handheld',
      voiceoverText: 'Ever tried it? Link below.',
      onScreenText: '',
      transitionOut: 'cut',
    },
  ],
};

describe.skipIf(!hasDb)('UGC actor pipeline on real Postgres (21.4)', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `ugcpipe-${randomUUID()}`;
  const style = newUgcStyle({ product: { name: 'Oat latte kit' } }, 7);

  afterAll(async () => {
    const ids = (
      await db.videoProject.findMany({ where: { organisationId: org }, select: { id: true } })
    ).map((p) => p.id);
    await db.textOverlay.deleteMany({ where: { shot: { script: { projectId: { in: ids } } } } });
    await db.videoShot.deleteMany({ where: { script: { projectId: { in: ids } } } });
    await db.videoScript.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoBrief.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoAsset.deleteMany({ where: { projectId: { in: ids } } });
    await db.providerJob.deleteMany({ where: { organisationId: org } });
    await db.providerUsage.deleteMany({ where: { organisationId: org } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  async function run(options: Parameters<typeof createHarness>[1]) {
    const h = createHarness(db, {
      script: UGC_SCRIPT,
      ideation: { ...IDEATION_JSON, realPersonRequested: false },
      transcriptWords: [
        { text: 'ever', startSec: 0.3, endSec: 0.7 },
        { text: 'tried', startSec: 0.7, endSec: 1.1 },
      ],
      // The rendered length the duration check reads (the 24 s format below).
      probe: { durationSec: 24 },
      ...options,
    });
    const { project, runId } = await createProject(db, {
      organisationId: org,
      description: 'A creator reviews our oat latte kit',
      metadata: { ugc: style },
      // 21.4a: the actor portrait is a reference image, so actor clips are 8 s.
      durationSec: 24,
    });
    const job: ProjectJobData = {
      projectId: project.id,
      organisationId: org,
      runId,
      planTier: 'STANDARD',
    };
    await h.queue.add('plan-project', job);
    await drainInline(h.queue, h.deps);
    const after = await db.videoProject.findUniqueOrThrow({
      where: { id: project.id },
      include: {
        scripts: {
          include: { shots: { orderBy: { sortOrder: 'asc' }, include: { overlays: true } } },
        },
        renders: true,
      },
    });
    const assets = await db.videoAsset.findMany({ where: { projectId: project.id } });
    return { h, after, assets, runId };
  }

  it('makes actor clips with the line, the seed and the same actor, and no TTS for them', async () => {
    const { h, after, assets } = await run({ actor: true });
    expect(after.state).toBe('READY_FOR_REVIEW');
    const shots = after.scripts[0]?.shots ?? [];
    // 21.4a: 8 s actor clips (the portrait is a reference image); the card absorbs the rest.
    expect(shots.map((s) => [s.visualTreatment, s.durationSec])).toEqual([
      ['UGC_ACTOR', 8],
      ['TEXT_CARD', 8],
      ['UGC_ACTOR', 8],
    ]);
    // Only actors speak: the card's line went on screen.
    expect(shots[1]?.voiceoverText).toBeNull();
    expect(shots[1]?.onScreenText).toBe('Two minutes, done.');

    const requests = h.adapters.veo.requests as ActorVideoRequest[];
    expect(requests.map((r) => r.spokenLine)).toEqual([
      'Mornings used to be chaos.',
      'Ever tried it? Link below.',
    ]);
    for (const r of requests) {
      expect(r).toMatchObject({ capability: 'actor_video', seed: 7, languageCode: 'en-GB' });
      expect(r.prompt).toContain(actorDescription(style));
      expect(r.prompt).not.toContain('Mornings used to be chaos');
    }
    // UGC is the narration: ElevenLabs is never asked for the actor shots.
    expect(h.adapters.elevenlabs.requests).toHaveLength(0);
    expect(shots.every((s) => s.voiceAssetId === null)).toBe(true);

    const clips = assets.filter((a) => a.kind === 'VIDEO_CLIP');
    expect(clips).toHaveLength(2);
    for (const clip of clips) {
      expect(clip.metadata).toMatchObject({
        speech: 'clip',
        wordTiming: { status: 'ok' },
        fit: { strategy: 'fits' },
      });
    }
    // Captions for the actor's own speech.
    expect(shots[0]?.overlays.some((o) => o.kind === 'caption')).toBe(true);
    // 21.4a: the clip's transcript is re-spelt to the script line ("ever" → "Ever").
    const cta = clips.find((c) => c.shotId === shots[2]?.id);
    expect(JSON.stringify(cta?.metadata)).toContain('"text":"Ever"');
  });

  it('21.4a: one actor portrait, generated once and sent to every actor clip', async () => {
    const { h, after, assets } = await run({ actor: true });
    const portraits = assets.filter(
      (a) => (a.metadata as { role?: string } | null)?.role === ACTOR_PORTRAIT_ROLE,
    );
    expect(portraits).toHaveLength(1);
    const portrait = portraits[0];
    expect(portrait).toMatchObject({ kind: 'IMAGE', shotId: null, costPence: 4 });
    expect((portrait?.metadata as { prompt: string }).prompt).toBe(actorPortraitPrompt(style));
    // The image generator was asked once, with the preset-only portrait prompt.
    const images = h.adapters.openai.requests.filter((r) => r.capability === 'text_to_image');
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ prompt: actorPortraitPrompt(style), aspectRatio: '9:16' });
    // Every actor clip carries the same portrait URL and points at it in the prompt.
    const requests = h.adapters.veo.requests as ActorVideoRequest[];
    expect(requests).toHaveLength(2);
    const urls = new Set(requests.map((r) => r.actorImageUrl));
    expect(urls.size).toBe(1);
    expect([...urls][0]).toContain(portrait?.s3Key ?? 'missing');
    for (const r of requests)
      expect(r.prompt).toContain('same person as in the reference portrait');
    expect(actorImageOf(after.metadata).state).toEqual({
      state: 'ready',
      description: actorDescription(style),
      assetId: portrait?.id,
    });
    const clips = assets.filter((a) => a.kind === 'VIDEO_CLIP');
    for (const clip of clips)
      expect(clip.metadata).toMatchObject({ actorImageAssetId: portrait?.id });
  });

  it('21.4a: regenerating one actor clip reuses the same portrait (no new image)', async () => {
    const { h, after } = await run({ actor: true });
    const shot = after.scripts[0]?.shots[2];
    const portraitId = actorImageOf(after.metadata).state;
    expect(portraitId?.state).toBe('ready');
    const tenant = {
      organisationId: org,
      organisation: { planTier: 'STANDARD' },
    } as unknown as TenantContext;
    await regenerateShot({ db, queue: h.queue }, tenant, shot?.id ?? 'missing', {});
    await drainInline(h.queue, h.deps);
    const images = h.adapters.openai.requests.filter((r) => r.capability === 'text_to_image');
    expect(images).toHaveLength(1);
    const requests = h.adapters.veo.requests as ActorVideoRequest[];
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((r) => r.actorImageUrl)).size).toBe(1);
  });

  it('21.4a: a refused portrait does not stop the video; clips go on without one', async () => {
    const { h, after, assets } = await run({
      actor: true,
      imageRespond: () => ({
        state: 'failed',
        error: { class: 'content_policy', message: 'refused', retryable: false },
      }),
    });
    expect(after.state).toBe('READY_FOR_REVIEW');
    const requests = h.adapters.veo.requests as ActorVideoRequest[];
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.actorImageUrl === undefined)).toBe(true);
    // Asked once for the run, not once per clip.
    expect(h.adapters.openai.requests.filter((r) => r.capability === 'text_to_image')).toHaveLength(
      1,
    );
    expect(actorImageOf(after.metadata).state).toMatchObject({
      state: 'unavailable',
      reason: 'content_policy',
    });
    expect(
      assets.some((a) => (a.metadata as { role?: string } | null)?.role === ACTOR_PORTRAIT_ROLE),
    ).toBe(false);
  });

  it('21.4a: no suggested label covers an actor; the short hook sits in the top band', async () => {
    const { after } = await run({
      actor: true,
      script: {
        ...UGC_SCRIPT,
        shots: [
          { ...UGC_SCRIPT.shots[0], onScreenText: 'Client calls?' },
          UGC_SCRIPT.shots[1],
          { ...UGC_SCRIPT.shots[2], onScreenText: 'not anymore though' },
        ],
      },
    });
    const shots = after.scripts[0]?.shots ?? [];
    const labels = (i: number) => shots[i]?.overlays.filter((o) => o.kind !== 'caption') ?? [];
    expect(labels(0).map((o) => [o.text, o.anchorY])).toEqual([
      ['Client calls?', UGC_HOOK_ANCHOR_Y],
    ]);
    expect(labels(2)).toHaveLength(0);
  });

  it('composes the clip audio at full level, with the AI label, and passes audio and caption sync', async () => {
    const { after, h } = await run({ actor: true });
    const render = after.renders[0];
    expect(render?.qualityCheckState).toBe('PASSED');
    const summary = render?.composition as {
      shots: Array<Record<string, unknown>>;
      brand: { aiLabel: boolean };
    };
    expect(summary.shots.filter((s) => s.speech === 'clip')).toHaveLength(2);
    expect(summary.brand.aiLabel).toBe(true);
    const checks = render?.qualityIssues as Array<{ code: string; status: string }>;
    expect(checks.find((c) => c.code === 'audio_sync')?.status).toBe('passed');
    expect(['passed', 'not_run']).toContain(checks.find((c) => c.code === 'caption_sync')?.status);
    const edit = JSON.stringify(h.adapters.shotstack.requests[0]);
    expect(edit).toContain('"src":"');
    expect(edit).toMatch(/"type":"video","src":"[^"]+","volume":1/);
  });

  it('stops before the script when ideation says the brief asks for a real person', async () => {
    const { after, h } = await run({
      actor: true,
      ideation: { ...IDEATION_JSON, realPersonRequested: true },
    });
    expect(after.state).toBe('DRAFT');
    expect(after.errorReason).toBe('ugc_real_person_refused');
    expect(after.scripts).toHaveLength(0);
    expect(h.adapters.veo.requests).toHaveLength(0);
  });

  it('an actor provider out of credit degrades the shots to narrated B-roll (actor_video)', async () => {
    const { after, h } = await run({
      actor: true,
      actorRespond: () => ({
        state: 'failed',
        error: { class: 'insufficient_credits', message: 'Prepay depleted', retryable: false },
      }),
    });
    const shots = after.scripts[0]?.shots ?? [];
    const actors = shots.filter((s) => s.visualTreatment === 'UGC_ACTOR');
    expect(actors).toHaveLength(2);
    // The line is narrated by the brand voice over a generated clip (Runway here).
    expect(actors.every((s) => s.voiceAssetId !== null && s.assetId !== null)).toBe(true);
    expect(h.adapters.elevenlabs.requests.length).toBeGreaterThanOrEqual(2);
    expect(h.adapters.runway.requests.length).toBeGreaterThanOrEqual(2);
    const degraded = (after.metadata as { degradedShots?: Array<{ degradedFrom: string }> })
      .degradedShots;
    expect(degraded?.map((d) => d.degradedFrom)).toEqual(['actor_video', 'actor_video']);
  });

  it('with no actor provider the script uses B-roll only and the video is narrated', async () => {
    const { after, h } = await run({
      actor: false,
      script: {
        fullText: 'x',
        shots: [
          {
            ...UGC_SCRIPT.shots[1],
            durationSec: 15,
            visualTreatment: 'TEXT_CARD',
            onScreenText: 'Oat kit',
          },
        ],
      },
    });
    expect(after.scripts[0]?.shots.map((s) => s.visualTreatment)).toEqual(['TEXT_CARD']);
    expect(h.adapters.veo.requests).toHaveLength(0);
  });
});
