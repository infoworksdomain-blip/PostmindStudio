import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as generateRoute from '../../src/app/api/studio/projects/[id]/generate/route';
import * as projectScriptsRoute from '../../src/app/api/studio/projects/[id]/scripts/route';
import * as regenerateScriptRoute from '../../src/app/api/studio/scripts/[id]/regenerate/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { seedOverlayPresets } from '../../src/lib/studio/overlays/seed-presets';
import { createProviderRegistry } from '../../src/lib/studio/providers/registry';
import { call } from '../helpers/api-harness';
import { SCRIPT_JSON } from '../helpers/pipeline-harness';
import { ScriptedAdapter } from '../helpers/scripted-adapter';
import {
  briefBody,
  cleanupGolden,
  createProject,
  drain,
  generate,
  getProject,
  startJourney,
} from './journey-kit';

// Phase 15 Track C journeys: pinned shots survive a script regeneration (15.C9), a named public
// figure goes to Trust & Safety review (15.C6), a project in French with an Arabic variant set
// (15.C5), generate overrides (15.C4) and a STOCK_FOOTAGE shot through the stock adapters.

const hasDb = Boolean(process.env.DATABASE_URL);
const HOOK_TIMEOUT_MS = 120_000;

type Script = {
  id: string;
  language: string;
  shots: Array<{ id: string; sortOrder: number; assetId: string | null; visualTreatment: string }>;
};

describe.skipIf(!hasDb)('Phase 15 Track C planning journeys', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const since = new Date();

  beforeAll(async () => {
    await seedOverlayPresets(db);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    setApiDeps(undefined);
    await cleanupGolden(db, since);
    await db.$disconnect();
  }, HOOK_TIMEOUT_MS);

  const scriptsOf = async (id: string) =>
    (await call(projectScriptsRoute.GET, { token: 'reader', params: { id } })).json
      .data as Script[];

  it('PC-01 regenerate a script around a pinned shot: its asset and position are kept', async () => {
    const j = startJourney(db, 'pc01');
    const id = await createProject(j, briefBody());
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    const [script] = await scriptsOf(id);
    const pinned = script!.shots[1]!;
    expect(pinned.assetId).toBeTruthy();

    const res = await call(regenerateScriptRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: script!.id },
      body: { instruction: 'Warmer tone', pinnedShotIds: [pinned.id] },
    });
    expect(res.status).toBe(202);
    expect(res.json.pinnedShotIds).toEqual([pinned.id]);
    await drain(j);
    expect((await getProject(j, id)).state).toBe('READY_FOR_REVIEW');

    const prompt = j.h.adapters.anthropic.requests
      .filter((r) => (r as { system: string }).system.includes('script and storyboard'))
      .at(-1) as { prompt: string };
    expect(prompt.prompt).toContain('pinned 1 shot');
    expect(prompt.prompt).toContain('Position 2');
    const [rewritten] = await scriptsOf(id);
    const kept = rewritten!.shots.find((s) => s.id === pinned.id);
    expect(kept).toMatchObject({ sortOrder: 1, assetId: pinned.assetId });
    expect(rewritten!.shots).toHaveLength(SCRIPT_JSON.shots.length + 1);
    expect(rewritten!.shots.map((s) => s.sortOrder)).toEqual([0, 1, 2, 3]);

    // Pinning a shot of another script is refused.
    const bad = await call(regenerateScriptRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: script!.id },
      body: { pinnedShotIds: ['not-a-shot'] },
    });
    expect(bad.status).toBe(400);
  });

  it('PC-02 a script naming a public figure is paused for review, even if tagged WARN', async () => {
    const j = startJourney(db, 'pc02', {
      safety: { verdict: 'WARN', categories: ['public_figure'], reason: 'Names a footballer' },
    });
    const id = await createProject(j, briefBody());
    await generate(j, id, { expectClean: false });
    expect(await db.safetyReview.count({ where: { projectId: id, state: 'PENDING' } })).toBe(1);
    const row = await db.videoProject.findUniqueOrThrow({ where: { id } });
    expect((row.metadata as { scriptSafety?: { verdict: string } }).scriptSafety?.verdict).toBe(
      'REVIEW',
    );
    expect(await db.videoAsset.count({ where: { projectId: id } })).toBe(0);
  });

  it('PC-03 a French video with an Arabic variant set: scripts per language, native prompts', async () => {
    const j = startJourney(db, 'pc03');
    const id = await createProject(j, briefBody({ language: 'fr', languages: ['ar'] }));
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    const scripts = await scriptsOf(id);
    expect(scripts.map((s) => s.language).sort()).toEqual(['ar', 'fr']);
    const prompts = j.h.adapters.anthropic.requests.map((r) => (r as { prompt: string }).prompt);
    expect(prompts.some((p) => p.includes('write every spoken and on-screen word in French'))).toBe(
      true,
    );
    expect(prompts.some((p) => p.includes('Modern Standard Arabic'))).toBe(true);
    // Unsupported languages are refused at create.
    const bad = await call((await import('../../src/app/api/studio/projects/route')).POST, {
      method: 'POST',
      token: 'owner',
      body: briefBody({ language: 'pcm' }),
    });
    expect(bad.status).toBe(400);
  });

  it('PC-04 generate overrides: a lower tier is used, above the plan is 422, unknown provider 400', async () => {
    const j = startJourney(db, 'pc04');
    const id = await createProject(j, briefBody());
    const gen = (body: Record<string, unknown>) =>
      call(generateRoute.POST, { method: 'POST', token: 'owner', params: { id }, body });
    expect((await gen({ qualityTier: 'ENTERPRISE' })).status).toBe(422);
    expect((await gen({ preferredProviders: { AI_CLIP: ['sora'] } })).status).toBe(400);
    const ok = await gen({ qualityTier: 'STANDARD', preferredProviders: { AI_CLIP: ['runway'] } });
    expect(ok.status).toBe(202);
    expect(ok.json).toMatchObject({ projectId: id, state: 'QUEUED', planTier: 'STANDARD' });
    await drain(j);
    expect((await getProject(j, id)).state).toBe('READY_FOR_REVIEW');
    const routing = (
      await db.videoShot.findFirstOrThrow({
        where: { script: { projectId: id }, visualTreatment: 'AI_CLIP' },
      })
    ).providerRouting as { visual?: { candidates: Array<{ providerId: string }> } };
    // STANDARD's list is luma, runway, kling: the preference moved runway to the front.
    expect(routing.visual?.candidates[0]?.providerId).toBe('runway');
  });

  it('PC-05 a STOCK_FOOTAGE shot is sourced from the stock adapter with its licence', async () => {
    const j = startJourney(db, 'pc05', {
      script: {
        ...SCRIPT_JSON,
        shots: SCRIPT_JSON.shots.map((s, i) =>
          i === 1 ? { ...s, visualTreatment: 'STOCK_FOOTAGE' } : s,
        ),
      },
    });
    const stock = new ScriptedAdapter('storyblocks-video', ['stock_footage'], () => ({
      state: 'succeeded',
      output: {
        url: 'https://cdn.storyblocks.example/clip.mp4',
        metadata: {
          stockItemId: '555',
          licence: { licence: 'storyblocks-api', attributionRequired: false },
          costPence: 0,
        },
      },
    }));
    j.h.deps.registry = createProviderRegistry([...j.h.deps.registry.list(), stock]);
    const id = await createProject(j, briefBody());
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    expect(stock.requests[0]).toMatchObject({
      capability: 'stock_footage',
      query: 'Baker scoring dough at dawn',
      aspectRatio: '9:16',
    });
    const asset = await db.videoAsset.findFirstOrThrow({
      where: { projectId: id, source: 'storyblocks-video' },
    });
    expect(asset.metadata).toMatchObject({ licence: { licence: 'storyblocks-api' } });
  });
});
