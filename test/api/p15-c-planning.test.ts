import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as generateRoute from '../../src/app/api/studio/projects/[id]/generate/route';
import * as projectRoute from '../../src/app/api/studio/projects/[id]/route';
import * as projectsRoute from '../../src/app/api/studio/projects/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { call, installApi, tenant } from '../helpers/api-harness';

// Phase 15 Track C through the real routes: project language(s) (15.C5), approval workflow
// choice and generate overrides (15.C4) — auth, validation, tenant isolation, audit.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('Track C project inputs API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-p15c-${randomUUID()}`;
  const tokens = {
    owner: tenant(org), // STANDARD plan
    reader: tenant(org, ['studio:project:read']),
    stranger: tenant(`api-p15c-other-${randomUUID()}`),
  };
  let api: ReturnType<typeof installApi>;

  beforeEach(() => {
    api = installApi(db, tokens);
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.videoProject.deleteMany({ where: { organisationId: org } });
    await db.approvalWorkflow.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  const body = (extra: Record<string, unknown> = {}) => ({
    name: 'Launch',
    businessId: 'biz-1',
    brief: { rawInput: 'Spring menu' },
    targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 30 }],
    ...extra,
  });
  const create = (extra: Record<string, unknown> = {}, token = 'owner') =>
    call(projectsRoute.POST, { method: 'POST', token, body: body(extra) });

  it('stores the language (canonical casing) and extra languages; rejects unsupported codes', async () => {
    const res = await create({ language: 'pt-br', languages: ['hi', 'zh-hans'] });
    expect(res.status).toBe(201);
    const project = res.json.project as { id: string; language: string; metadata: unknown };
    expect(project.language).toBe('pt-BR');
    expect(project.metadata).toMatchObject({ languages: ['hi', 'zh-Hans'] });
    expect((await create()).json.project).toMatchObject({ language: 'en-GB' });
    for (const bad of [{ language: 'pcm' }, { language: 'en' }, { languages: ['fr', 'fr'] }])
      expect((await create(bad)).status).toBe(400);

    const patched = await call(projectRoute.PATCH, {
      method: 'PATCH',
      token: 'owner',
      params: { id: project.id },
      body: { language: 'ar' },
    });
    expect(patched.status).toBe(200);
    expect((patched.json.project as { language: string }).language).toBe('ar');
    const other = await call(projectRoute.PATCH, {
      method: 'PATCH',
      token: 'stranger',
      params: { id: project.id },
      body: { language: 'fr' },
    });
    expect(other.status).toBe(404);
    expect((await create({ language: 'fr' }, 'reader')).status).toBe(403);
  });

  it('accepts an approval workflow of the organisation only', async () => {
    const wf = await db.approvalWorkflow.create({
      data: {
        organisationId: org,
        name: 'Client sign-off',
        steps: [{ role: 'admin', minApprovers: 1 }],
        appliesTo: {},
      },
    });
    const ok = await create({ approvalWorkflowId: wf.id });
    expect(ok.status).toBe(201);
    expect((ok.json.project as { metadata: unknown }).metadata).toMatchObject({
      approvalWorkflowId: wf.id,
    });
    expect((await create({ approvalWorkflowId: 'wf_other' })).status).toBe(400);
  });

  it('generate: tier ceiling 422, unknown provider 400, lower tier and preferences accepted', async () => {
    const id = ((await create()).json.project as { id: string }).id;
    const gen = (b: Record<string, unknown>, token = 'owner') =>
      call(generateRoute.POST, { method: 'POST', token, params: { id }, body: b });
    const above = await gen({ qualityTier: 'PLUS' });
    expect(above.status).toBe(422);
    expect(above.json).toMatchObject({ error: 'unprocessable' });
    expect((await gen({ preferredProviders: { AI_CLIP: ['veo'] } })).status).toBe(400); // PLUS-only
    expect((await gen({ preferredProviders: { TEXT_CARD: ['x'] } })).status).toBe(400);
    expect((await gen({ qualityTier: 'BASIC' }, 'stranger')).status).toBe(404);

    const ok = await gen({ qualityTier: 'BASIC', preferredProviders: { AI_CLIP: ['replicate'] } });
    expect(ok.status).toBe(202);
    expect(ok.json).toMatchObject({ planTier: 'BASIC', state: 'QUEUED' });
    const job = api.queue.take();
    expect(job?.data).toMatchObject({ planTier: 'BASIC' });
    const row = await db.videoProject.findUniqueOrThrow({ where: { id } });
    expect(row.metadata).toMatchObject({
      preferredProviders: { AI_CLIP: ['replicate'] },
      qualityTierOverride: { requested: 'BASIC', plan: 'STANDARD' },
    });
    expect(api.audits.at(-1)).toMatchObject({ action: 'studio.project.generate' });
  });
});
