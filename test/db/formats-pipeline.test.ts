import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import type { ActorVideoRequest } from '../../src/lib/studio/providers/interface';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import type { ProjectJobData } from '../../src/lib/studio/queue/queues';
import { hookDemoCreateInput, newHookDemoDocument } from '../../src/lib/studio/formats/hook-demo';
import { newWallOfTextDocument } from '../../src/lib/studio/formats/wall-of-text';
import { HOOK_CAPTION_ANCHOR_Y } from '../../src/lib/studio/formats/caption-style';
import { NO_ON_SCREEN_TEXT } from '../../src/lib/studio/providers/dialogue';
import { VeoAdapter } from '../../src/lib/studio/providers/veo';
import { createHarness, createProject } from '../helpers/pipeline-harness';

// BACKLOG 22.1 / 22.2 — both Fastlane-style formats through the real pipeline on real Postgres
// with scripted providers: plan-project routing, the hook line / text block from (scripted)
// Claude, the safety gate, the fixed shot plans, ONE silent reaction clip per aspect ratio from
// the actor route (followers reuse it), the demo kept as the second shot, composition, the
// quality gate and review; then the failure paths (no demo, no way to make a hook).

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)(
  'Fastlane-style formats on real Postgres (22.1 / 22.2)',
  { timeout: 60_000 },
  () => {
    const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
    const org = `fmt-${randomUUID()}`;

    afterAll(async () => {
      const ids = (
        await db.videoProject.findMany({ where: { organisationId: org }, select: { id: true } })
      ).map((p) => p.id);
      await db.textOverlay.deleteMany({ where: { shot: { script: { projectId: { in: ids } } } } });
      await db.videoShot.deleteMany({ where: { script: { projectId: { in: ids } } } });
      await db.videoScript.deleteMany({ where: { projectId: { in: ids } } });
      await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
      await db.videoAsset.deleteMany({ where: { projectId: { in: ids } } });
      await db.providerJob.deleteMany({ where: { organisationId: org } });
      await db.providerUsage.deleteMany({ where: { organisationId: org } });
      await db.videoProject.deleteMany({ where: { id: { in: ids } } });
      await db.$disconnect();
    });

    async function drain(h: ReturnType<typeof createHarness>, projectId: string, runId: string) {
      const job: ProjectJobData = { projectId, organisationId: org, runId, planTier: 'STANDARD' };
      await h.queue.add('plan-project', job);
      await drainInline(h.queue, h.deps);
      return db.videoProject.findUniqueOrThrow({
        where: { id: projectId },
        include: {
          scripts: {
            orderBy: { createdAt: 'asc' },
            include: { shots: { orderBy: { sortOrder: 'asc' }, include: { overlays: true } } },
          },
          renders: true,
        },
      });
    }

    /** A hook + demo project with its demo asset (as POST /projects attaches it). */
    async function hookDemoProject(over: Record<string, unknown> = {}, demoSec = 40) {
      const { project, runId } = await createProject(db, {
        organisationId: org,
        sourceType: 'HOOK_DEMO',
        description: 'Our booking app takes a reservation in two taps',
        targetFormats: [
          { platform: 'tiktok', aspectRatio: '9:16', duration: 15 },
          { platform: 'instagram_reel', aspectRatio: '9:16', duration: 15 },
        ],
      });
      const demo = await db.videoAsset.create({
        data: {
          organisationId: org,
          projectId: project.id,
          kind: 'VIDEO_CLIP',
          source: 'upload',
          s3Bucket: 'uploads',
          s3Key: `orgs/${org}/uploads/${randomUUID()}/source.mp4`,
          durationSec: demoSec,
          widthPx: 1080,
          heightPx: 1920,
          metadata: { fileName: 'booking-demo.mp4' },
        },
      });
      const doc = newHookDemoDocument(hookDemoCreateInput.parse(over), {
        uploadId: 'upload-1',
        assetId: demo.id,
      });
      await db.videoProject.update({
        where: { id: project.id },
        data: { metadata: { runId, hookDemo: doc } },
      });
      return { project, runId, demo };
    }

    it('hook + demo: Claude’s hook line, one silent reaction clip, then the demo, to review', async () => {
      const h = createHarness(db, { actor: true, probe: { durationSec: 15 } });
      const { project, runId, demo } = await hookDemoProject();
      const after = await drain(h, project.id, runId);
      expect(after.state).toBe('READY_FOR_REVIEW');
      expect(after.scripts).toHaveLength(2);
      for (const script of after.scripts) {
        expect(script.targetDurationSec).toBe(15);
        expect(script.shots.map((s) => [s.visualTreatment, s.durationSec])).toEqual([
          ['AI_CLIP', 3],
          ['USER_UPLOAD', 12],
        ]);
        expect(script.shots[1]?.assetId).toBe(demo.id);
        // ONE caption, on the hook only, upper middle, TikTok-classic (stroke, no box).
        expect(script.shots[0]?.overlays).toHaveLength(1);
        expect(script.shots[1]?.overlays).toHaveLength(0);
        expect(script.shots[0]?.overlays[0]).toMatchObject({
          text: 'Still taking bookings by phone?',
          kind: 'on_screen',
          anchorY: HOOK_CAPTION_ANCHOR_Y,
          backgroundType: 'none',
          strokeColor: '#000000',
        });
      }
      // One clip for the shared 9:16 ratio: the second script's hook reuses it (no second payment).
      const requests = h.adapters.veo.requests as ActorVideoRequest[];
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        capability: 'actor_video',
        silent: true,
        spokenLine: '',
        durationSec: 4,
        aspectRatio: '9:16',
      });
      expect(requests[0]?.prompt).toContain('does not speak');
      // 21.4c: the Veo body ends with the no-on-screen-text instruction (silent clips too).
      const veo = new VeoAdapter({ apiKey: 'k', usdToGbpRate: 0.79 });
      const body = (await veo.buildBody(requests[0] as ActorVideoRequest)) as {
        instances: Array<{ prompt: string }>;
      };
      expect(body.instances[0]?.prompt.endsWith(NO_ON_SCREEN_TEXT)).toBe(true);
      expect(body.instances[0]?.prompt).not.toContain('says: "');
      expect(requests[0]?.prompt).not.toContain('Still taking bookings');
      // No narration for either shot.
      expect(h.adapters.elevenlabs.requests).toHaveLength(0);
      // Silent hook, demo audio at the balanced mix, AI label on, gate passed.
      expect(after.renders).toHaveLength(2);
      for (const render of after.renders) {
        expect(render.qualityCheckState).toBe('PASSED');
        expect((render.composition as { brand: { aiLabel: boolean } }).brand.aiLabel).toBe(true);
      }
      const edit = JSON.stringify(h.adapters.shotstack.requests[0]);
      expect(edit).toMatch(/"type":"video","src":"[^"]+","volume":0\b/);
      expect(edit).toMatch(/"type":"video","src":"[^"]+","volume":0\.8/);
      expect((after.metadata as { hookDemo: { writtenHookLine: string } }).hookDemo).toMatchObject({
        writtenHookLine: 'Still taking bookings by phone?',
      });
    });

    it('hook + demo: the owner’s hook line is used as written (no Claude call for it)', async () => {
      const h = createHarness(db, { actor: true, probe: { durationSec: 15 } });
      const { project, runId } = await hookDemoProject({ hookLine: 'Two taps. Table booked.' });
      const after = await drain(h, project.id, runId);
      expect(after.scripts[0]?.shots[0]?.overlays[0]?.text).toBe('Two taps. Table booked.');
      const asked = h.adapters.anthropic.requests.filter(
        (r) =>
          r.capability === 'text_generation' && r.system.includes('ONE line of on-screen text'),
      );
      expect(asked).toHaveLength(0);
    });

    it('hook + demo without a demo asset fails with no_demo_video before any spend', async () => {
      const h = createHarness(db, { actor: true });
      const { project, runId, demo } = await hookDemoProject();
      await db.videoAsset.delete({ where: { id: demo.id } });
      const after = await drain(h, project.id, runId);
      expect(after.state).toBe('FAILED');
      expect(after.errorReason).toMatch(/^no_demo_video/);
      expect(h.adapters.veo.requests).toHaveLength(0);
    });

    it('hook + demo with no actor provider and no licensed library clip fails clearly', async () => {
      const h = createHarness(db, { actor: false });
      const { project, runId } = await hookDemoProject();
      const after = await drain(h, project.id, runId);
      expect(after.state).toBe('FAILED');
      expect(after.errorReason).toMatch(/^hook_clip_unavailable/);
    });

    it('wall of text: Claude’s block over stock footage, one overlay, no AI clip, to review', async () => {
      const h = createHarness(db, { stock: true, probe: { durationSec: 8 } });
      const { project, runId } = await createProject(db, {
        organisationId: org,
        sourceType: 'WALL_OF_TEXT',
        description: 'Three habits that save an hour a day',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 8 }],
      });
      await db.videoProject.update({
        where: { id: project.id },
        data: {
          metadata: {
            runId,
            wallOfText: newWallOfTextDocument({ background: 'nature', durationSec: 8 }),
          },
        },
      });
      const after = await drain(h, project.id, runId);
      expect(after.state).toBe('READY_FOR_REVIEW');
      const shots = after.scripts[0]?.shots ?? [];
      expect(shots.map((s) => [s.visualTreatment, s.durationSec])).toEqual([['STOCK_FOOTAGE', 8]]);
      expect(shots[0]?.overlays).toHaveLength(1);
      expect(shots[0]?.overlays[0]).toMatchObject({
        text: 'Three habits\n- Plan tomorrow tonight\n- Batch errands',
        startAtSec: 0,
        endAtSec: 8,
        backgroundType: 'none',
      });
      // Pixabay videos are the only stock source (as in production) and the one asked.
      expect(h.adapters.stockVideo.providerId).toBe('pixabay');
      expect(h.adapters.stockVideo.requests).toHaveLength(1);
      expect(h.adapters.stockVideo.requests[0]).toMatchObject({
        capability: 'stock_footage',
        query: 'nature forest water',
        durationSec: 8,
      });
      expect(shots[0]?.providerRouting).toMatchObject({ visual: { providerId: 'pixabay' } });
      expect(h.adapters.runway.requests).toHaveLength(0);
      expect(h.adapters.elevenlabs.requests).toHaveLength(0);
      expect(after.renders[0]?.qualityCheckState).toBe('PASSED');
    });

    it('wall of text with no library clip and no stock source fails with no_background_video', async () => {
      const h = createHarness(db, { stock: false });
      const { project, runId } = await createProject(db, {
        organisationId: org,
        sourceType: 'WALL_OF_TEXT',
        description: 'Three habits that save an hour a day',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 8 }],
      });
      await db.videoProject.update({
        where: { id: project.id },
        data: {
          metadata: {
            runId,
            wallOfText: newWallOfTextDocument({ background: 'calm', durationSec: 8 }),
          },
        },
      });
      const after = await drain(h, project.id, runId);
      expect(after.state).toBe('FAILED');
      expect(after.errorReason).toMatch(/^no_background_video/);
      expect(after.scripts).toHaveLength(0);
    });

    it('wall of text whose stock search finds nothing fails with no_background_video', async () => {
      const h = createHarness(db, { stock: true });
      h.adapters.stockVideo.respond = () => ({
        state: 'failed',
        error: { class: 'invalid_request', message: 'no match', retryable: false },
      });
      const { project, runId } = await createProject(db, {
        organisationId: org,
        sourceType: 'WALL_OF_TEXT',
        description: 'Three habits that save an hour a day',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 8 }],
      });
      await db.videoProject.update({
        where: { id: project.id },
        data: {
          metadata: {
            runId,
            wallOfText: newWallOfTextDocument({ background: 'city', durationSec: 8 }),
          },
        },
      });
      const after = await drain(h, project.id, runId);
      expect(after.state).toBe('FAILED');
      expect(after.scripts[0]?.shots[0]?.errorReason).toMatch(/^no_background_video/);
    });
  },
);
