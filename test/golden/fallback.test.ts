import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { QualityCheck } from '../../src/lib/studio/pipeline/quality-checks';
import { openSafetyReview, SAFETY_REVIEW_ACTOR } from '../../src/lib/studio/pipeline/safety-review';
import { runQualityGate } from '../../src/lib/studio/queue/workers/run-quality-gate';
import { NO_PROVIDER_SCAN_DETAIL } from '../../src/lib/studio/services/safety-reviews';
import { HeyGenAdapter } from '../../src/lib/studio/providers/heygen';
import { LumaAdapter } from '../../src/lib/studio/providers/luma';
import type { ProviderAdapter } from '../../src/lib/studio/providers/interface';
import { createProviderRegistry } from '../../src/lib/studio/providers/registry';
import { tenant } from '../helpers/api-harness';
import { SCRIPT_JSON } from '../helpers/pipeline-harness';
import {
  approve,
  cleanupGolden,
  createProject,
  generate,
  ORG_PREFIX,
  startJourney,
  type Journey,
} from './journey-kit';

// BACKLOG 13.32 fallback journeys, through the real routes, workers, router and breaker, with
// the REAL Luma / HeyGen adapters talking to doc-shaped fake HTTP (docs.agents.lumalabs.ai,
// developers.heygen.com):
//   GF-01  PLUS plan, Runway's breaker open → Luma produces every AI clip → review → approve
//   GF-02  STANDARD plan, an AI_AVATAR shot → narration first, HeyGen lip-syncs to it → review
// BACKLOG 20.19 (production 2026-10-02, HeyGen out of API credits):
//   GF-03  HeyGen render fails with MOVIO_PAYMENT_INSUFFICIENT_CREDIT → the avatar shot becomes a
//          Runway clip, keeps its narration and duration, is marked degraded → compose → gate →
//          review, and HeyGen is held out of routing
//   GF-04  HeyGen refuses the content → no degradation, the video fails as before
//   GF-05  (20.21, Hive removed) no content-safety provider → the scan is skipped ("Not
//          scanned") and the video goes straight on to the normal review: no Trust & Safety
//          review, no block, no QUALITY_FAILED, no operator alert
//   GF-06  (20.21) a run 20.19 parked behind a "no provider" Trust & Safety review is released on
//          the worker's next quality-gate pass: not scanned → READY_FOR_REVIEW

const hasDb = Boolean(process.env.DATABASE_URL);
const HOOK_TIMEOUT_MS = 120_000;

interface Recorded {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function readBody(init?: RequestInit): Record<string, unknown> | undefined {
  return typeof init?.body === 'string'
    ? (JSON.parse(init.body) as Record<string, unknown>)
    : undefined;
}

/** Luma Agents API double: POST /generations → queued; GET → completed with an MP4 URL. */
function lumaHttp() {
  const calls: Recorded[] = [];
  let seq = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: readBody(init) });
    if (method === 'POST' && url.endsWith('/v1/generations')) {
      seq += 1;
      return reply(
        {
          id: `00000000-0000-4000-8000-00000000000${seq}`,
          type: 'video',
          state: 'queued',
          model: 'ray-3.2',
          created_at: '2026-09-27T12:00:00Z',
          output: [],
          failure_reason: null,
          failure_code: null,
        },
        201,
      );
    }
    const id = url.split('/').at(-1) ?? '';
    return reply({
      id,
      type: 'video',
      state: 'completed',
      model: 'ray-3.2',
      created_at: '2026-09-27T12:00:00Z',
      output: [{ type: 'video', url: `https://storage.luma.invalid/${id}.mp4?X-Amz-Expires=3600` }],
      failure_reason: null,
      failure_code: null,
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

/** HeyGen v3 double whose render fails with `failure` (GET /v3/videos/{id} status failed). */
function heygenFailingHttp(failure: { code: string; message: string }) {
  const calls: Recorded[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: readBody(init) });
    if (method === 'POST') {
      return reply({ data: { video_id: 'hg-video-x', status: 'waiting', output_format: 'mp4' } });
    }
    return reply({
      data: {
        id: 'hg-video-x',
        status: 'failed',
        video_url: null,
        thumbnail_url: null,
        duration: null,
        failure_code: failure.code,
        failure_message: failure.message,
      },
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const AVATAR_SCRIPT = {
  ...SCRIPT_JSON,
  shots: SCRIPT_JSON.shots.map((s, i) =>
    i === 0
      ? { ...s, visualTreatment: 'AI_AVATAR', sceneDescription: 'Presenter at the counter' }
      : s,
  ),
};

/** HeyGen v3 double: POST /v3/videos → waiting; GET → completed with duration. */
function heygenHttp() {
  const calls: Recorded[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: readBody(init) });
    if (method === 'POST') {
      return reply({ data: { video_id: 'hg-video-1', status: 'waiting', output_format: 'mp4' } });
    }
    return reply({
      data: {
        id: 'hg-video-1',
        status: 'completed',
        video_url: 'https://files.heygen.invalid/hg-video-1.mp4',
        thumbnail_url: null,
        duration: 6,
        failure_code: null,
        failure_message: null,
      },
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function register(j: Journey, ...extra: ProviderAdapter[]) {
  j.h.deps.registry = createProviderRegistry([...j.h.deps.registry.list(), ...extra]);
}

async function shotsOf(db: PrismaClient, projectId: string) {
  const shots = await db.videoShot.findMany({
    where: { script: { projectId } },
    orderBy: { sortOrder: 'asc' },
  });
  const assets = await db.videoAsset.findMany({
    where: { id: { in: shots.flatMap((s) => (s.assetId ? [s.assetId] : [])) } },
    select: { id: true, source: true, costPence: true },
  });
  return shots.map((shot) => ({ ...shot, asset: assets.find((a) => a.id === shot.assetId) }));
}

describe.skipIf(!hasDb)('provider fallback journeys (13.32)', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const since = new Date();

  afterAll(async () => {
    setApiDeps(undefined);
    await cleanupGolden(db, since);
    await db.$disconnect();
  }, HOOK_TIMEOUT_MS);

  it('GF-01 Runway breaker open → Luma produces the clips → review → approve', async () => {
    const org = `${ORG_PREFIX}-gf01`;
    const plus = { ...tenant(org), organisation: { id: org, planTier: 'PLUS' } };
    const j = startJourney(db, 'gf01', {}, { owner: plus });
    const http = lumaHttp();
    register(
      j,
      new LumaAdapter({ apiKey: 'luma-key', usdToGbpRate: 0.75, fetchImpl: http.fetchImpl }),
    );
    for (let i = 0; i < 5; i += 1) await j.h.deps.breaker.recordFailure('runway');
    expect(await j.h.deps.breaker.state('runway')).toBe('open');

    const id = await createProject(j);
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');

    expect(j.h.adapters.runway.requests).toHaveLength(0);
    const posts = http.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2); // the two AI_CLIP shots; the text card needs no provider
    for (const post of posts) {
      expect(post.body).toMatchObject({
        model: 'ray-3.2',
        type: 'video',
        aspect_ratio: '9:16',
        video: { resolution: '720p', duration: '10s' }, // 6s shots render as 10s clips
      });
    }

    const clips = (await shotsOf(db, id)).filter((s) => s.visualTreatment === 'AI_CLIP');
    expect(clips).toHaveLength(2);
    for (const shot of clips) {
      expect(shot.state).toBe('READY');
      expect(shot.asset?.source).toBe('luma:ray-3.2');
      expect(shot.asset?.costPence).toBe(68); // $0.90 per 10s clip at 0.75 → 68p
      expect(shot.providerRouting).toMatchObject({
        visual: {
          providerId: 'luma',
          candidates: [
            { providerId: 'seedance', skipped: 'not_configured' },
            { providerId: 'veo', skipped: 'not_configured' },
            { providerId: 'runway', skipped: 'circuit_open' },
            { providerId: 'luma' },
          ],
        },
      });
    }
    const spend = await db.providerJob.aggregate({
      where: { projectId: id, provider: 'luma', state: 'SUCCEEDED' },
      _sum: { costPence: true },
      _count: true,
    });
    expect(spend).toMatchObject({ _count: 2, _sum: { costPence: 136 } });
    await approve(j, id);
  });

  it('GF-02 AI_AVATAR shot → narration first → HeyGen lip-syncs to it → review', async () => {
    const script = {
      ...SCRIPT_JSON,
      shots: SCRIPT_JSON.shots.map((s, i) =>
        i === 0
          ? { ...s, visualTreatment: 'AI_AVATAR', sceneDescription: 'Presenter at the counter' }
          : s,
      ),
    };
    const j = startJourney(db, 'gf02', { script });
    const http = heygenHttp();
    register(
      j,
      new HeyGenAdapter({
        apiKey: 'hg-key',
        defaultAvatarId: 'stock-look',
        usdToGbpRate: 0.75,
        fetchImpl: http.fetchImpl,
      }),
    );

    const id = await createProject(j);
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');

    const [avatar] = await shotsOf(db, id);
    expect(avatar).toMatchObject({ visualTreatment: 'AI_AVATAR', state: 'READY' });
    expect(avatar?.asset?.source).toBe('heygen');
    expect(avatar?.asset?.costPence).toBe(23); // 6s * $0.05 * 0.75 = 22.5p → 23p
    expect(avatar?.voiceAssetId).toBeTruthy();
    expect(avatar?.providerRouting).toMatchObject({
      visual: {
        providerId: 'heygen',
        candidates: [{ providerId: 'd-id', skipped: 'not_configured' }, { providerId: 'heygen' }],
      },
      voice: { providerId: 'elevenlabs' },
    });

    const post = http.calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({
      type: 'avatar',
      avatar_id: 'stock-look',
      // the shot's ElevenLabs narration, via a signed URL
      audio_url: `https://signed.example/assets/orgs/x/voice-${avatar?.id}.mp3`,
      aspect_ratio: '9:16',
      resolution: '1080p',
      output_format: 'mp4',
      title: `PostMind Studio shot ${avatar?.id}`,
    });
    // Narration was generated for the avatar shot before HeyGen was called.
    const voiceRequests = j.h.adapters.elevenlabs.requests.map(
      (r) => (r as { shotId?: string }).shotId,
    );
    expect(voiceRequests).toContain(avatar?.id);
    expect(j.h.adapters.runway.requests).toHaveLength(1); // the remaining AI_CLIP shot
  });

  it('GF-03 HeyGen out of credits → the avatar shot becomes a clip → compose → review', async () => {
    const j = startJourney(db, 'gf03', { script: AVATAR_SCRIPT });
    const http = heygenFailingHttp({
      code: 'MOVIO_PAYMENT_INSUFFICIENT_CREDIT',
      message: "Insufficient credit. This operation requires 'api' credits.",
    });
    register(
      j,
      new HeyGenAdapter({
        apiKey: 'hg-key',
        defaultAvatarId: 'stock-look',
        usdToGbpRate: 0.75,
        fetchImpl: http.fetchImpl,
      }),
    );

    const id = await createProject(j);
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');

    const [avatar] = await shotsOf(db, id);
    expect(avatar).toMatchObject({ visualTreatment: 'AI_AVATAR', state: 'READY', durationSec: 6 });
    expect(avatar?.asset?.source).toBe('runway');
    expect(avatar?.voiceAssetId).toBeTruthy(); // the narration made for the avatar is kept
    expect(avatar?.providerRouting).toMatchObject({
      visual: {
        providerId: 'runway',
        degradedFrom: 'avatar_video',
        degradedReason: 'insufficient_credits',
      },
      voice: { providerId: 'elevenlabs' },
    });
    const asset = await db.videoAsset.findUniqueOrThrow({ where: { id: avatar?.assetId ?? '' } });
    expect(asset.metadata).toMatchObject({ degradedFrom: 'avatar_video' });

    // The clip illustrates the narration, without a presenter, through the router (cost tracked).
    const clip = j.h.adapters.runway.requests.find(
      (r) => (r as { shotId?: string }).shotId === avatar?.id,
    ) as { capability: string; prompt: string; durationSec: number } | undefined;
    expect(clip).toMatchObject({ capability: 'text_to_video', durationSec: 6 });
    expect(clip?.prompt).toContain('Still buying supermarket bread?');
    expect(clip?.prompt).toContain('No presenter');
    const jobs = await db.providerJob.findMany({
      where: { projectId: id, provider: { in: ['heygen', 'runway'] } },
      select: { provider: true, state: true, errorClass: true },
    });
    expect(jobs).toEqual(
      expect.arrayContaining([
        { provider: 'heygen', state: 'FAILED', errorClass: 'insufficient_credits' },
        { provider: 'runway', state: 'SUCCEEDED', errorClass: null },
      ]),
    );

    // HeyGen is held out of routing (20.11).
    expect(await j.h.deps.breaker.state('heygen')).toBe('open');

    // The review screen's gentle note.
    const stored = await db.videoProject.findUniqueOrThrow({ where: { id } });
    expect((stored.metadata as { degradedShots?: unknown }).degradedShots).toEqual([
      { shotId: avatar?.id, degradedFrom: 'avatar_video', reason: 'insufficient_credits' },
    ]);
  });

  it('GF-04 HeyGen refuses the content → no degradation, the video fails as before', async () => {
    const j = startJourney(db, 'gf04', { script: AVATAR_SCRIPT });
    const http = heygenFailingHttp({
      code: 'content_policy_violation',
      message: 'The request violates the content policy',
    });
    register(
      j,
      new HeyGenAdapter({
        apiKey: 'hg-key',
        defaultAvatarId: 'stock-look',
        usdToGbpRate: 0.75,
        fetchImpl: http.fetchImpl,
      }),
    );

    const id = await createProject(j);
    const project = await generate(j, id, { expectClean: false });
    expect(project.state).toBe('FAILED');
    expect(project.errorReason).toContain('asset_generation_failed');
    const [avatar] = await shotsOf(db, id);
    expect(avatar?.state).toBe('FAILED');
    expect(
      j.h.adapters.runway.requests.some((r) => (r as { shotId?: string }).shotId === avatar?.id),
    ).toBe(false);
  });

  it('GF-05 no content-safety provider → not scanned, straight on to review', async () => {
    const j = startJourney(db, 'gf05');
    expect(j.h.deps.registry.getAdaptersByCapability('content_safety')).toEqual([]);

    const id = await createProject(j);
    const project = await generate(j, id);
    expect(project.state).toBe('READY_FOR_REVIEW');
    expect(project.errorReason).toBeNull();
    const stored = await db.videoProject.findUniqueOrThrow({ where: { id } });
    const metadata = stored.metadata as { safetyReview?: unknown; contentSafety?: unknown };
    expect(metadata.safetyReview).toBeUndefined();
    expect(metadata.contentSafety).toEqual({ state: 'skipped', reason: 'no_provider' });
    expect(await db.safetyReview.count({ where: { projectId: id } })).toBe(0);
    const renders = await db.videoRender.findMany({ where: { projectId: id } });
    expect(renders.length).toBeGreaterThan(0);
    for (const render of renders) {
      expect(render.qualityCheckState).toBe('PASSED');
      expect(render.qualityIssues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'content_safety',
            status: 'not_run',
            severity: 'info',
            detailKey: 'safetyNotScanned',
          }),
        ]),
      );
    }
    // No content-safety provider call was attempted (so no account alert can follow), and the
    // creator got no safety-review message.
    expect(
      await db.providerJob.count({ where: { projectId: id, operation: 'content_safety' } }),
    ).toBe(0);
    expect(
      await db.notification.count({ where: { kind: 'safety_review', organisationId: j.org } }),
    ).toBe(0);
  });

  it('GF-06 a 20.19 no-provider safety hold is released on the next gate pass', async () => {
    const j = startJourney(db, 'gf06');
    const id = await createProject(j);
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    const ready = await db.videoProject.findUniqueOrThrow({ where: { id } });
    const runId = (ready.metadata as { runId: string }).runId;
    const renders = await db.videoRender.findMany({ where: { projectId: id } });

    // Put the run back exactly where 20.19 left it: the scan "could not run" (review-level), the
    // project paused in QUALITY_CHECKING behind a PENDING content review.
    const legacy: QualityCheck = {
      code: 'content_safety',
      status: 'failed',
      severity: 'error',
      detail: NO_PROVIDER_SCAN_DETAIL,
      detailKey: 'safetyScanUnavailable',
      detailParams: { reason: 'no content-safety provider available' },
    };
    for (const render of renders) {
      const checks = (render.qualityIssues as unknown as QualityCheck[]).map((c) =>
        c.code === 'content_safety' ? legacy : c,
      );
      await db.videoRender.update({
        where: { id: render.id },
        data: {
          qualityCheckState: 'FAILED',
          qualityIssues: checks as unknown as Prisma.InputJsonValue,
        },
      });
    }
    await db.$executeRaw`UPDATE "studio"."video_projects" SET "state" = 'QUALITY_CHECKING', "completedAt" = NULL, "metadata" = "metadata" - 'contentSafety' WHERE "id" = ${id}`;
    const review = await openSafetyReview(j.h.deps, {
      organisationId: j.org,
      projectId: id,
      runId,
      planTier: 'STANDARD',
      kind: 'content',
      reason: renders.map((r) => `${r.targetPlatform}: ${legacy.detail}`).join('; '),
      details: renders.map((r) => ({
        renderId: r.id,
        platform: r.targetPlatform,
        detail: legacy.detail,
      })),
      renderIds: renders.map((r) => r.id),
    });

    const job = { projectId: id, organisationId: j.org, runId, planTier: 'STANDARD' as const };
    await runQualityGate(job, j.h.deps);

    const after = await db.videoProject.findUniqueOrThrow({ where: { id } });
    expect(after.state).toBe('READY_FOR_REVIEW');
    expect(after.metadata).toMatchObject({
      safetyReview: { id: review.id, state: 'ALLOWED' },
      contentSafety: { state: 'skipped', reason: 'no_provider' },
    });
    expect(await db.safetyReview.findUniqueOrThrow({ where: { id: review.id } })).toMatchObject({
      state: 'ALLOWED',
      decidedByUserId: SAFETY_REVIEW_ACTOR,
    });
    for (const render of await db.videoRender.findMany({ where: { projectId: id } })) {
      expect(render.qualityCheckState).toBe('PASSED');
      expect(render.qualityIssues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'content_safety', status: 'not_run' }),
        ]),
      );
    }
    expect(j.h.audits.some((a) => a.action === 'studio.safety_review.release')).toBe(true);

    // A second pass changes nothing.
    await runQualityGate(job, j.h.deps);
    expect((await db.videoProject.findUniqueOrThrow({ where: { id } })).state).toBe(
      'READY_FOR_REVIEW',
    );
    await db.safetyReview.deleteMany({ where: { projectId: id } });
  });
});
