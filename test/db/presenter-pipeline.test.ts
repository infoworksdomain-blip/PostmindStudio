import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  ActorVideoRequest,
  AvatarVideoRequest,
} from '../../src/lib/studio/providers/interface';
import { createProviderRegistry } from '../../src/lib/studio/providers/registry';
import { StubAdapter } from '../../src/lib/studio/providers/test-adapter';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import type { ProjectJobData } from '../../src/lib/studio/queue/queues';
import { presenterActorImageOf } from '../../src/lib/studio/ugc/presenter';
import { ACTOR_PORTRAIT_ROLE } from '../../src/lib/studio/ugc/portrait';
import { createHarness, createProject, SCRIPT_JSON } from '../helpers/pipeline-harness';

// BACKLOG 23.2 (operator decision 2026-10-06: HeyGen is the back-up) — an AI_AVATAR shot in an
// ordinary AI video through the real pipeline on real Postgres with scripted providers: the
// presenter is made by the actor route (Veo) speaking the line natively, with the business's
// default creator portrait (22.3) or a one-off presenter portrait; HeyGen is used only when no
// actor provider can make it (account problem / hold), and then lip-syncs to the brand narration.

const hasDb = Boolean(process.env.DATABASE_URL);

const PRESENTER_SCRIPT = {
  ...SCRIPT_JSON,
  shots: SCRIPT_JSON.shots.map((s, i) =>
    i === 0
      ? {
          ...s,
          visualTreatment: 'AI_AVATAR',
          sceneDescription: 'stands at the bakery counter holding a loaf',
          onScreenText: '',
        }
      : s,
  ),
};

describe.skipIf(!hasDb)(
  'presenter shots: actor route first, HeyGen back-up (23.2)',
  { timeout: 60_000 },
  () => {
    const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
    const org = `presenter-${randomUUID()}`;

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
      await db.imageLibraryItem.deleteMany({ where: { organisationId: org } });
      await db.videoProject.deleteMany({ where: { id: { in: ids } } });
      await db.creatorPortrait.deleteMany({ where: { organisationId: org } });
      await db.creator.deleteMany({ where: { organisationId: org } });
      await db.$disconnect();
    });

    async function run(
      options: Parameters<typeof createHarness>[1],
      prepare?: (h: ReturnType<typeof createHarness>) => Promise<void> | void,
    ) {
      const h = createHarness(db, {
        script: PRESENTER_SCRIPT,
        transcriptWords: [
          { text: 'still', startSec: 0.2, endSec: 0.5 },
          { text: 'buying', startSec: 0.5, endSec: 0.9 },
        ],
        ...options,
      });
      const heygen = new StubAdapter('heygen', ['avatar_video'], { costPence: 23 });
      h.deps.registry = createProviderRegistry([...h.deps.registry.list(), heygen]);
      await prepare?.(h);
      const { project, runId } = await createProject(db, { organisationId: org });
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
        include: { scripts: { include: { shots: { orderBy: { sortOrder: 'asc' } } } } },
      });
      const presenter = after.scripts[0]?.shots[0];
      const assets = await db.videoAsset.findMany({ where: { projectId: project.id } });
      return { h, heygen, after, presenter, assets };
    }

    it('renders the presenter with Veo and the default creator portrait; no TTS, no HeyGen', async () => {
      const creator = await db.creator.create({
        data: {
          organisationId: org,
          businessId: 'biz-1',
          name: 'Maya',
          gender: 'woman',
          ageRange: '25-34',
          setting: 'shop',
          description: 'a woman around thirty, short curly hair, green apron',
          status: 'READY',
          isDefault: true,
          createdByUserId: 'user-1',
        },
      });
      const portrait = await db.creatorPortrait.create({
        data: {
          organisationId: org,
          businessId: 'biz-1',
          creatorId: creator.id,
          source: 'GENERATED',
          s3Bucket: 'assets',
          s3Key: `orgs/${org}/creators/${creator.id}/portrait.png`,
          contentType: 'image/png',
          createdByUserId: 'user-1',
        },
      });
      await db.creator.update({ where: { id: creator.id }, data: { portraitId: portrait.id } });

      const { h, heygen, after, presenter, assets } = await run({ actor: true });
      expect(after.state).toBe('READY_FOR_REVIEW');
      expect(presenter).toMatchObject({ visualTreatment: 'AI_AVATAR', state: 'READY' });

      const [request] = h.adapters.veo.requests as ActorVideoRequest[];
      expect(request).toMatchObject({
        capability: 'actor_video',
        spokenLine: 'Still buying supermarket bread?',
        languageCode: 'en-GB',
        durationSec: 6,
      });
      expect(request?.actorImageUrl).toContain(portrait.s3Key);
      expect(request?.prompt).toContain('a woman around thirty, short curly hair, green apron');
      expect(request?.prompt).toContain('same person as in the reference portrait');
      expect(request?.prompt).not.toContain('Still buying supermarket bread?');

      // The presenter speaks natively: no narration for that shot, HeyGen never asked.
      expect(presenter?.voiceAssetId).toBeNull();
      const voiced = h.adapters.elevenlabs.requests.map((r) => (r as { shotId?: string }).shotId);
      expect(voiced).not.toContain(presenter?.id);
      expect(heygen.submitCalls).toHaveLength(0);

      const clip = assets.find((a) => a.id === presenter?.assetId);
      expect(clip?.source).toBe('veo');
      expect(clip?.metadata).toMatchObject({
        speech: 'clip',
        presenter: 'actor',
        creatorId: creator.id,
        // Captions from the clip's own speech, re-spelt to the script line.
        wordTiming: { status: 'ok', providerId: 'assemblyai' },
      });
      expect(JSON.stringify(clip?.metadata)).toContain('"text":"Still"');
      expect(presenter?.providerRouting).toMatchObject({ visual: { providerId: 'veo' } });
      // Cost tracked like any provider job.
      expect(
        await db.providerJob.count({
          where: { projectId: after.id, provider: 'veo', state: 'SUCCEEDED' },
        }),
      ).toBe(1);
      await db.creator.update({ where: { id: creator.id }, data: { isDefault: false } });
    });

    it('without a creator, makes one presenter portrait (not a UGC project) and sends it', async () => {
      const { h, after, presenter, assets } = await run({ actor: true });
      expect(after.state).toBe('READY_FOR_REVIEW');
      const portraits = assets.filter(
        (a) => (a.metadata as { role?: string } | null)?.role === ACTOR_PORTRAIT_ROLE,
      );
      expect(portraits).toHaveLength(1);
      expect(presenterActorImageOf(after.metadata).state).toMatchObject({
        state: 'ready',
        assetId: portraits[0]?.id,
      });
      expect((after.metadata as Record<string, unknown>).ugc).toBeUndefined();
      const [request] = h.adapters.veo.requests as ActorVideoRequest[];
      expect(request?.actorImageUrl).toContain(portraits[0]?.s3Key ?? 'missing');
      expect(presenter?.voiceAssetId).toBeNull();
    });

    it('falls back to HeyGen (with narration) only when Veo is out of credits', async () => {
      const { h, heygen, after, presenter } = await run({
        actor: true,
        actorRespond: () => ({
          state: 'failed',
          error: { class: 'insufficient_credits', message: 'no credits', retryable: false },
        }),
      });
      expect(after.state).toBe('READY_FOR_REVIEW');
      expect(h.adapters.veo.requests.length).toBeGreaterThan(0);
      expect(heygen.submitCalls).toHaveLength(1);
      const avatar = heygen.submitCalls[0] as AvatarVideoRequest;
      expect(avatar).toMatchObject({ capability: 'avatar_video', durationSec: 6 });
      // The brand narration was made for HeyGen to lip-sync.
      expect(presenter?.voiceAssetId).toBeTruthy();
      expect(presenter?.providerRouting).toMatchObject({
        visual: { providerId: 'heygen', candidates: [{ providerId: 'heygen' }] },
        voice: { providerId: 'elevenlabs' },
      });
      // Veo is held out of routing (20.11), so the next presenter goes straight to HeyGen.
      expect(await h.deps.breaker.state('veo')).toBe('open');
    });

    it('goes straight to HeyGen when the actor providers are held', async () => {
      const { h, heygen, presenter } = await run({ actor: true }, async (harness) => {
        await harness.deps.breaker.tripAccount?.('veo', {
          errorClass: 'insufficient_credits',
          reason: 'no credits',
          until: harness.deps.now() + 3_600_000,
        });
      });
      expect(h.adapters.veo.requests).toHaveLength(0);
      expect(heygen.submitCalls).toHaveLength(1);
      expect(presenter?.voiceAssetId).toBeTruthy();
    });
  },
);
