import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as generateRoute from '../../src/app/api/studio/projects/[id]/generate/route';
import * as projectRoute from '../../src/app/api/studio/projects/[id]/route';
import * as projectsRoute from '../../src/app/api/studio/projects/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { DIRECTION_CHOSEN_INSTRUCTION } from '../../src/lib/studio/pipeline/ideation';
import type { ProjectJobData } from '../../src/lib/studio/queue/queues';
import { planProject } from '../../src/lib/studio/queue/workers/plan-project';
import { call, installApi, tenant } from '../helpers/api-harness';
import { createHarness, IDEATION_JSON, type HarnessOptions } from '../helpers/pipeline-harness';

// BACKLOG 20.18 — a "too vague" brief through the real routes: GET /projects/:id exposes the
// suggested directions, and generating with a chosen direction (or simply generating again)
// reaches the script stage instead of asking again. Providers are scripted (no paid calls).

const hasDb = Boolean(process.env.DATABASE_URL);

const VAGUE = {
  ...IDEATION_JSON,
  actionable: false,
  directionOptions: [
    'A countdown to our launch with a rocket animation',
    '  Three facts about space our customers love  ',
    'Behind the scenes of our space-themed studio',
    'A fourth option that is dropped',
  ],
  hook: '',
  keyMessage: '',
  targetAudience: '',
  tone: '',
  callToAction: '',
  keywords: [],
};

describe.skipIf(!hasDb)('vague brief → directions → generate (20.18)', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-vague-${randomUUID()}`;
  const tokens = {
    owner: tenant(org),
    reader: tenant(org, ['studio:project:read']),
  };
  const options: HarnessOptions = {};
  const h = createHarness(db, options);
  let api: ReturnType<typeof installApi>;

  beforeEach(() => {
    api = installApi(db, tokens, { queue: h.queue });
  });

  afterAll(async () => {
    setApiDeps(undefined);
    const ids = (
      await db.videoProject.findMany({ where: { organisationId: org }, select: { id: true } })
    ).map((p) => p.id);
    await db.textOverlay.deleteMany({ where: { shot: { script: { projectId: { in: ids } } } } });
    await db.videoShot.deleteMany({ where: { script: { projectId: { in: ids } } } });
    await db.videoScript.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoBrief.deleteMany({ where: { projectId: { in: ids } } });
    await db.providerJob.deleteMany({ where: { organisationId: org } });
    await db.providerUsage.deleteMany({ where: { organisationId: org } });
    await db.videoProject.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  async function createProject(): Promise<string> {
    const res = await call(projectsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: {
        name: 'space video',
        businessId: 'biz-1',
        brief: { rawInput: 'space video' },
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 15 }],
      },
    });
    expect(res.status).toBe(201);
    return (res.json.project as { id: string }).id;
  }

  async function generate(id: string, body: Record<string, unknown>, token = 'owner') {
    return call(generateRoute.POST, { method: 'POST', token, params: { id }, body });
  }

  /** Run only the plan-project job the generate call queued (Layers 1–2 and the safety gate). */
  async function plan(): Promise<void> {
    const job = h.queue.take();
    expect(job?.name).toBe('plan-project');
    await planProject(job?.data as ProjectJobData, h.deps);
    // The fan-out (generate-asset jobs) is not needed here.
    while (h.queue.take());
  }

  function lastIdeationPrompt(): string {
    const ideation = h.adapters.anthropic.requests.filter(
      (r) => r.capability === 'text_generation' && r.system.includes('ideation layer'),
    );
    const last = ideation.at(-1);
    return last && last.capability === 'text_generation' ? last.prompt : '';
  }

  async function makeVague(): Promise<string> {
    const id = await createProject();
    options.ideation = VAGUE;
    expect((await generate(id, {})).status).toBe(202);
    await plan();
    return id;
  }

  it('exposes the directions on GET /projects/:id while the project waits in DRAFT', async () => {
    const id = await makeVague();
    expect(lastIdeationPrompt()).not.toContain(DIRECTION_CHOSEN_INSTRUCTION);
    const res = await call(projectRoute.GET, { token: 'reader', params: { id } });
    expect(res.status).toBe(200);
    const project = res.json.project as {
      state: string;
      errorReason: string;
      directionOptions: string[];
      metadata: Record<string, unknown>;
    };
    expect(project.state).toBe('DRAFT');
    // Customers get the reason code (the presenter drops Studio's English after the colon).
    expect(project.errorReason).toBe('brief_too_vague');
    expect(project.directionOptions).toEqual([
      'A countdown to our launch with a rocket animation',
      'Three facts about space our customers love',
      'Behind the scenes of our space-themed studio',
    ]);
    expect(project.metadata).toMatchObject({ lastBriefVague: true });
  });

  it('generating with a chosen direction tells ideation not to ask again and reaches the script stage', async () => {
    const id = await makeVague();
    options.ideation = IDEATION_JSON;
    const res = await generate(id, {
      rawInput: 'Three facts about space our customers love',
      directionChosen: true,
    });
    expect(res.status).toBe(202);
    expect(api.audits.at(-1)).toMatchObject({
      action: 'studio.project.generate',
      metadata: expect.objectContaining({ directionChosen: true }),
    });
    const queued = await db.videoProject.findUniqueOrThrow({ where: { id } });
    expect(queued.description).toBe('Three facts about space our customers love');
    expect(queued.metadata).toMatchObject({ directionChosen: true });
    expect((queued.metadata as Record<string, unknown>).directionOptions).toBeUndefined();

    await plan();
    const prompt = lastIdeationPrompt();
    expect(prompt).toContain(DIRECTION_CHOSEN_INSTRUCTION);
    expect(prompt).toContain('Three facts about space our customers love');

    const after = await db.videoProject.findUniqueOrThrow({
      where: { id },
      include: { scripts: true, brief: true },
    });
    expect(after.state).toBe('ASSETS_QUEUED');
    expect(after.errorReason).toBeNull();
    expect(after.scripts.length).toBeGreaterThan(0);
    expect(after.metadata).toMatchObject({ lastBriefVague: false });
    const detail = await call(projectRoute.GET, { token: 'owner', params: { id } });
    expect((detail.json.project as { directionOptions: string[] }).directionOptions).toEqual([]);
  });

  it('never answers "too vague" twice in a row, even on a plain Generate again', async () => {
    const id = await makeVague();
    // The model still says "too vague": the second answer becomes a brief from the first direction.
    expect((await generate(id, {})).status).toBe(202);
    await plan();
    expect(lastIdeationPrompt()).toContain(DIRECTION_CHOSEN_INSTRUCTION);
    const after = await db.videoProject.findUniqueOrThrow({
      where: { id },
      include: { scripts: true, brief: true },
    });
    expect(after.state).toBe('ASSETS_QUEUED');
    expect(after.scripts.length).toBeGreaterThan(0);
    expect(after.brief).toMatchObject({
      hook: 'A countdown to our launch with a rocket animation',
      keyMessage: 'A countdown to our launch with a rocket animation',
    });
  });

  it('rejects a non-boolean directionChosen and needs studio:project:write', async () => {
    const id = await makeVague();
    expect((await generate(id, { directionChosen: 'yes' })).status).toBe(400);
    expect((await generate(id, { rawInput: 'x', directionChosen: true }, 'reader')).status).toBe(
      403,
    );
  });
  // Spec 13.3: restricted topics — the same kind of dead end before 20.18.
  describe('restricted topics → confirm or edit', () => {
    const FLAGGED = { ...IDEATION_JSON, restrictedTopicsMentioned: ['politics', ' politics '] };

    async function makeRestricted(): Promise<string> {
      const id = await createProject();
      options.ideation = FLAGGED;
      expect((await generate(id, {})).status).toBe(202);
      await plan();
      return id;
    }

    it('exposes the topics on GET /projects/:id while the project waits in DRAFT', async () => {
      const id = await makeRestricted();
      const res = await call(projectRoute.GET, { token: 'reader', params: { id } });
      const project = res.json.project as {
        state: string;
        errorReason: string;
        pendingRestrictedTopics: string[];
        directionOptions: string[];
      };
      expect(project.state).toBe('DRAFT');
      expect(project.errorReason).toBe('restricted_topics');
      expect(project.pendingRestrictedTopics).toEqual(['politics']);
      expect(project.directionOptions).toEqual([]);
    });

    it('"Continue anyway" (confirmRestrictedTopics) reaches the script stage', async () => {
      const id = await makeRestricted();
      expect((await generate(id, { confirmRestrictedTopics: true }, 'reader')).status).toBe(403);
      const res = await generate(id, { confirmRestrictedTopics: true });
      expect(res.status).toBe(202);
      expect(api.audits.at(-1)).toMatchObject({
        action: 'studio.project.generate',
        metadata: expect.objectContaining({ confirmRestrictedTopics: true }),
      });
      await plan();
      const after = await db.videoProject.findUniqueOrThrow({
        where: { id },
        include: { scripts: true },
      });
      expect(after.state).toBe('ASSETS_QUEUED');
      expect(after.scripts.length).toBeGreaterThan(0);
      expect(after.metadata).toMatchObject({ restrictedTopicsConfirmed: true });
      expect((after.metadata as Record<string, unknown>).pendingRestrictedTopics).toBeUndefined();
      const detail = await call(projectRoute.GET, { token: 'owner', params: { id } });
      expect(
        (detail.json.project as { pendingRestrictedTopics: string[] }).pendingRestrictedTopics,
      ).toEqual([]);
    });

    it('an edited brief is checked again and, without restricted topics, goes ahead', async () => {
      const id = await makeRestricted();
      options.ideation = IDEATION_JSON;
      const res = await generate(id, { rawInput: 'An autumn offer for members' });
      expect(res.status).toBe(202);
      await plan();
      const after = await db.videoProject.findUniqueOrThrow({ where: { id } });
      expect(after.description).toBe('An autumn offer for members');
      expect(after.state).toBe('ASSETS_QUEUED');
      expect(after.metadata).not.toMatchObject({ restrictedTopicsConfirmed: true });
    });
  });
});
