import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { setApiDeps } from '../../src/lib/studio/api/context';
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
});
