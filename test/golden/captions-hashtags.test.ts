import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as hashtagsRoute from '../../src/app/api/studio/businesses/[id]/hashtags/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { seedOverlayPresets } from '../../src/lib/studio/overlays/seed-presets';
import { call } from '../helpers/api-harness';
import { IDEATION_JSON } from '../helpers/pipeline-harness';
import {
  approve,
  BUSINESS_ID,
  briefBody,
  cleanupGolden,
  connect,
  createProject,
  drain,
  generate,
  getProject,
  ORG_PREFIX,
  startJourney,
} from './journey-kit';

// 20.13 golden: generate → approve → auto-publish. 23.2: the post copy is written by its own
// light call from the brief (in parallel with Layer 2); the auto-published post carries the business hashtag first, the owner's
// "always" hashtag, then the generated ones — at least five — through the real routes, workers
// and publish worker (inline queue).

const hasDb = Boolean(process.env.DATABASE_URL);
const HOOK_TIMEOUT_MS = 120_000;

describe.skipIf(!hasDb)('captions and hashtags journey (20.13)', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const since = new Date();

  beforeAll(async () => {
    await seedOverlayPresets(db);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    setApiDeps(undefined);
    await db.businessHashtagSettings.deleteMany({
      where: { organisationId: { startsWith: ORG_PREFIX } },
    });
    await cleanupGolden(db, since);
    await db.$disconnect();
  }, HOOK_TIMEOUT_MS);

  it('GH-01 generated video → approved → auto-published with business + always + generated tags', async () => {
    const j = startJourney(db, 'gh01', {
      ideation: {
        ...IDEATION_JSON,
        socialPosts: [
          {
            platform: 'tiktok',
            caption: 'Still buying supermarket bread?\nOur sourdough is baked at dawn.',
            hashtags: ['sourdough', '#LeedsBakery', 'aheadai', 'real bread', 'FreshBread'],
            title: '',
          },
        ],
      },
    });
    const put = await call(hashtagsRoute.PUT, {
      method: 'PUT',
      token: 'owner',
      params: { id: BUSINESS_ID },
      body: { primaryHashtag: '#AheadAI', alwaysHashtags: ['LeedsEats'] },
    });
    expect(put.status).toBe(200);

    const conn = await connect(j, 'tiktok');
    const id = await createProject(
      j,
      briefBody({
        publishPolicy: 'AUTO_ON_APPROVAL',
        autoPublish: { targets: [{ platform: 'tiktok', connectionId: conn.id }] },
      }),
    );
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');

    // 23.2: the post copy is its own light call (Haiku), written from the brief alongside Layer 2;
    // its prompt names the hashtags Studio adds itself. Ideation no longer writes the copy.
    const postCopy = j.h.adapters.anthropic.requests.find((r) =>
      'system' in r ? r.system.includes('per-platform social captions') : false,
    );
    expect(postCopy).toMatchObject({ task: 'post_copy' });
    expect(postCopy && 'prompt' in postCopy ? postCopy.prompt : '').toContain(
      'do not repeat them: #AheadAI #LeedsEats',
    );
    const ideation = j.h.adapters.anthropic.requests.find((r) =>
      'system' in r ? r.system.includes('ideation layer') : false,
    );
    expect(ideation).toMatchObject({ task: 'ideation' });
    expect(ideation && 'prompt' in ideation ? ideation.prompt : '').not.toContain(
      'Social posts: write one caption',
    );
    const meta = (await db.videoProject.findUniqueOrThrow({ where: { id } })).metadata as {
      captionSuggestions?: { source: string; suggestions: Record<string, { hashtags: string[] }> };
    };
    expect(meta.captionSuggestions?.source).toBe('ideation');
    expect(meta.captionSuggestions?.suggestions.tiktok?.hashtags).toEqual([
      'AheadAI',
      'LeedsEats',
      'sourdough',
      'LeedsBakery',
      'FreshBread',
    ]);

    await approve(j, id);
    await drain(j);
    expect((await getProject(j, id)).state).toBe('PUBLISHED');
    const [sent] = j.h.publishers.tiktok.published;
    expect(sent?.hashtags).toEqual([
      'AheadAI',
      'LeedsEats',
      'sourdough',
      'LeedsBakery',
      'FreshBread',
    ]);
    expect(sent?.text).toBe(
      'Still buying supermarket bread?\nOur sourdough is baked at dawn.\n\n#AheadAI #LeedsEats #sourdough #LeedsBakery #FreshBread',
    );
    const [pub] = await db.videoPublication.findMany({ where: { projectId: id } });
    expect(pub?.hashtags.length).toBeGreaterThanOrEqual(5);
  });

  it('GH-02 no generated copy: auto-publish tops up from the business and brief instead of failing', async () => {
    const j = startJourney(db, 'gh02');
    await call(hashtagsRoute.PUT, {
      method: 'PUT',
      token: 'owner',
      params: { id: BUSINESS_ID },
      body: { primaryHashtag: 'AheadAI', alwaysHashtags: [] },
    });
    const conn = await connect(j, 'tiktok');
    const id = await createProject(
      j,
      briefBody({
        publishPolicy: 'AUTO_ON_APPROVAL',
        autoPublish: {
          targets: [{ platform: 'tiktok', connectionId: conn.id, hashtags: ['Bake'] }],
        },
      }),
    );
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    // The default harness ideation has no socialPosts: no generated hashtags at all.
    await approve(j, id);
    await drain(j);
    const [sent] = j.h.publishers.tiktok.published;
    expect(sent?.hashtags[0]).toBe('AheadAI');
    expect(sent?.hashtags).toContain('Bake');
    // Keywords "sourdough" and "Leeds" from the brief fill the rest.
    expect(sent?.hashtags).toEqual(expect.arrayContaining(['Sourdough', 'Leeds']));
    expect(sent?.hashtags.length).toBeGreaterThanOrEqual(4);
  });
});
