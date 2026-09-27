import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as autoPopulateRoute from '../../src/app/api/studio/projects/[id]/auto-populate/route';
import * as projectRoute from '../../src/app/api/studio/projects/[id]/route';
import * as rerenderRoute from '../../src/app/api/studio/renders/[id]/rerender/route';
import * as templatesRoute from '../../src/app/api/studio/slideshow-templates/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { MUSIC_ALONE_VOLUME, MUSIC_UNDER_VOICE_VOLUME } from '../../src/lib/studio/pipeline/edl';
import { createProviderRegistry } from '../../src/lib/studio/providers/registry';
import { seedSlideshowTemplates } from '../../src/lib/studio/slideshow/seed-templates';
import { call, tenant } from '../helpers/api-harness';
import { musicDouble } from '../helpers/music-double';
import { SCRIPT_JSON, type HarnessOptions } from '../helpers/pipeline-harness';
import {
  approve,
  BUSINESS_ID,
  cleanupGolden,
  createProject,
  drain,
  generate,
  ORG_PREFIX,
  rendersOf,
  startJourney,
  type Journey,
} from './journey-kit';

// Layer 5 music journeys (spec 5.6, 12.4; A5.4), through the real routes and workers:
//   GM-01  Brief → generate (STANDARD) → one ElevenLabs Music track under the narration →
//          re-render reuses the track (no second charge) → approve
//   GM-02  Slideshow from a template → music is the only audio, prompted with the template mood
//   GM-03  BASIC plan → narration only, the music provider is never called
//   GM-04  Music provider refuses → the video is still ready for review, marked "failed"

const hasDb = Boolean(process.env.DATABASE_URL);
const HOOK_TIMEOUT_MS = 120_000;

type Clip = { asset: { type: string; src?: string; volume?: number; effect?: string } };
type Edit = { timeline: { tracks: Array<{ clips: Clip[] }> } };

function withMusic(j: Journey, music = musicDouble()) {
  j.h.deps.registry = createProviderRegistry([...j.h.deps.registry.list(), music]);
  return music;
}

const lastEdit = (j: Journey) =>
  (j.h.adapters.shotstack.requests.at(-1) as unknown as { edit: Edit }).edit;
const musicTrack = (edit: Edit) =>
  edit.timeline.tracks.at(-1)?.clips.every((c) => c.asset.src?.includes('/music-'))
    ? edit.timeline.tracks.at(-1)
    : undefined;

async function musicStatus(j: Journey, id: string) {
  const res = await call(projectRoute.GET, { token: 'reader', params: { id } });
  expect(res.status).toBe(200);
  const project = res.json.project as { metadata: { music?: Record<string, unknown> } };
  return project.metadata.music;
}

describe.skipIf(!hasDb)('music journeys (Layer 5)', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const since = new Date();

  beforeAll(async () => {
    await seedSlideshowTemplates(db);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    setApiDeps(undefined);
    await cleanupGolden(db, since);
    await db.$disconnect();
  }, HOOK_TIMEOUT_MS);

  it('GM-01 brief → music under narration → re-render reuses it → approve', async () => {
    const j = startJourney(db, 'gm01');
    const music = withMusic(j);
    const id = await createProject(j);
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');

    expect(music.requests).toHaveLength(1);
    expect(music.requests[0]).toMatchObject({ capability: 'music', durationSec: 15 });
    const track = musicTrack(lastEdit(j));
    expect(track?.clips).toHaveLength(1);
    expect(track?.clips[0]?.asset).toMatchObject({
      type: 'audio',
      volume: MUSIC_UNDER_VOICE_VOLUME,
      effect: 'fadeOut',
    });
    expect(await musicStatus(j, id)).toMatchObject({ status: 'generated', reused: false });
    const spend = await db.providerJob.aggregate({
      where: { projectId: id, provider: 'elevenlabs-music' },
      _sum: { costPence: true },
    });
    expect(spend._sum.costPence).toBe(3);

    const [render] = await rendersOf(j, id);
    const rerender = await call(rerenderRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: render?.id ?? '' },
    });
    expect(rerender.status).toBe(202);
    await drain(j);
    expect(music.requests).toHaveLength(1); // not generated (or paid for) twice
    expect(await musicStatus(j, id)).toMatchObject({ status: 'generated', reused: true });
    expect(musicTrack(lastEdit(j))).toBeDefined();
    expect(await rendersOf(j, id)).toHaveLength(2);
    await approve(j, id);
  });

  it('GM-02 slideshow → music is the only audio, prompted with the template mood', async () => {
    const j = startJourney(db, 'gm02');
    const music = withMusic(j);
    const templates = (await call(templatesRoute.GET, { token: 'reader' })).json.data as Array<{
      id: string;
      category: string;
      musicMood: string | null;
    }>;
    const listicle = templates.find((t) => t.category === 'listicle_5');
    expect(listicle?.musicMood).toBe('rhythmic beat');
    const id = await createProject(j, {
      name: 'Five reasons listicle',
      businessId: BUSINESS_ID,
      sourceType: 'SLIDESHOW',
      targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 15 }],
      slideshow: { templateId: listicle?.id, topic: 'Why our sourdough is different' },
    });
    const populate = await call(autoPopulateRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id },
    });
    expect(populate.status).toBe(202);
    await drain(j);
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');

    expect(music.requests).toHaveLength(1);
    const request = music.requests[0];
    if (request?.capability !== 'music') throw new Error('expected a music request');
    expect(request.prompt).toContain('rhythmic');
    const edit = lastEdit(j);
    const audio = edit.timeline.tracks
      .flatMap((t) => t.clips)
      .filter((c) => c.asset.type === 'audio');
    expect(audio.length).toBeGreaterThan(0);
    expect(audio.every((c) => c.asset.volume === MUSIC_ALONE_VOLUME)).toBe(true);
    expect(await musicStatus(j, id)).toMatchObject({ status: 'generated' });
  });

  it('GM-03 BASIC plan → narration only; the music provider is never called', async () => {
    const org = `${ORG_PREFIX}-gm03`;
    // BASIC routes AI clips to Fal/Replicate (not scripted here), so the script uses text cards.
    const options: HarnessOptions = {
      script: {
        ...SCRIPT_JSON,
        shots: SCRIPT_JSON.shots.map((s) => ({ ...s, visualTreatment: 'TEXT_CARD' })),
      },
    };
    const basic = { ...tenant(org), organisation: { id: org, planTier: 'basic' } };
    const j = startJourney(db, 'gm03', options, { owner: basic });
    const music = withMusic(j);
    const id = await createProject(j);
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    expect(music.requests).toHaveLength(0);
    expect(await musicStatus(j, id)).toMatchObject({ status: 'off_for_plan' });
    expect(musicTrack(lastEdit(j))).toBeUndefined();
  });

  it('GM-04 music refused by the provider → video still ready, music marked failed', async () => {
    const j = startJourney(db, 'gm04');
    withMusic(
      j,
      musicDouble(() => ({
        state: 'failed',
        error: { class: 'content_policy', message: 'bad_prompt: refused', retryable: false },
      })),
    );
    const id = await createProject(j);
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    expect(await musicStatus(j, id)).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('bad_prompt'),
    });
    expect(musicTrack(lastEdit(j))).toBeUndefined();
    const [render] = await rendersOf(j, id);
    expect(render?.qualityCheckState).toBe('PASSED');
  });
});
