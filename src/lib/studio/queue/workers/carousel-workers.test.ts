import type { VideoProject } from '@prisma/client';
import sharp from 'sharp';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineDeps } from '../../pipeline/deps';
import type { ProjectJobData } from '../queues';

// 21.6: the CAROUSEL plan step (plan-carousel.ts) and the render job (render-carousel.ts) with
// fake dependencies: Claude, pictures, captions and approval are mocked; slides really render.

const generate = vi.fn();
const runProvider = vi.fn();
const fillCarouselPictures = vi.fn();
const generateSlideshowCopy = vi.fn();
const autoApproveIfTrusted = vi.fn();
const notifyGenerationComplete = vi.fn();

vi.mock('../../carousel/writer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../carousel/writer')>()),
  projectTextGenerator: () => generate,
  loadThreadContext: async () => ({
    language: 'en-GB',
    facts: { businessName: 'Acme' },
    voice: [],
    restrictedTopics: [],
  }),
}));
vi.mock('../../pipeline/provider-run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../pipeline/provider-run')>()),
  runProvider: (...args: unknown[]) => runProvider(...args),
}));
vi.mock('../../carousel/images', () => ({ fillCarouselPictures }));
vi.mock('../../services/caption-suggestions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/caption-suggestions')>()),
  generateSlideshowCopy: (...args: unknown[]) => generateSlideshowCopy(...args),
}));
vi.mock('../../automation/auto-approve', () => ({ autoApproveIfTrusted }));
vi.mock('../../notifications/events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../notifications/events')>()),
  notifyGenerationComplete: (...args: unknown[]) => notifyGenerationComplete(...args),
}));
vi.mock('../../images/library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../images/library')>()),
  libraryDepsFrom: () => ({}),
}));

const { planCarousel } = await import('./plan-carousel');
const { renderCarousel, onRenderCarouselFailed } = await import('./render-carousel');

const data: ProjectJobData = {
  projectId: 'prj_1',
  organisationId: 'org_1',
  runId: 'run_1',
  planTier: 'STANDARD',
};

const storedCarousel = (posts: unknown[]) => ({
  version: 1,
  theme: 'light',
  language: 'en-GB',
  profile: { displayName: 'Acme', handle: 'acme', logoUploadId: null },
  posts,
  postCount: 3,
  aiWritten: false,
  rewrites: 0,
});

let picture: Buffer;
beforeAll(async () => {
  picture = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();
});

function makeDeps(project: Record<string, unknown>) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  log.child.mockReturnValue(log);
  const tx = {
    videoScript: { deleteMany: vi.fn(), create: vi.fn(async () => ({ id: 'script_1' })) },
    videoRender: { create: vi.fn(async () => ({ id: 'render_1' })) },
    $executeRaw: vi.fn(async () => 1),
  };
  const db = {
    videoProject: {
      findUnique: vi.fn(async () => ({
        id: 'prj_1',
        organisationId: 'org_1',
        businessId: 'biz_1',
        brandKitId: null,
        language: 'en-GB',
        description: 'Bread tips for busy mornings',
        ...project,
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    imageLibraryItem: { findFirst: vi.fn(async () => ({ s3Bucket: 'assets', s3Key: 'p.png' })) },
    videoUpload: { findFirst: vi.fn(async () => null) },
    brandKit: { findFirst: vi.fn(async () => null) },
  };
  const storage = {
    put: vi.fn(async (i: { bucket: string; key: string }) => ({ ...i, url: '' })),
    size: vi.fn(async () => picture.length),
    readRange: vi.fn(async () => new Uint8Array(picture)),
    signedUrl: vi.fn(),
    delete: vi.fn(),
  };
  const queue = { add: vi.fn() };
  const deps = {
    db,
    storage,
    queue,
    logger: log,
    now: () => Date.parse('2026-10-04T12:00:00Z'),
    config: { rendersBucket: 'renders' },
    fetch: vi.fn(),
  } as unknown as PipelineDeps;
  return { deps, db, tx, queue, storage };
}

const states = (db: ReturnType<typeof makeDeps>['db']) =>
  db.videoProject.updateMany.mock.calls.map(
    (c) => ((c as unknown[])[0] as { data: { state?: string } }).data.state,
  );

/** The first argument of a mock's n-th call. */
function firstArg(fn: { mock: { calls: unknown[] } }, n: number): unknown {
  return (fn.mock.calls[n] as unknown[] | undefined)?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  fillCarouselPictures.mockImplementation(async (_d: unknown, _s: unknown, posts: unknown[]) => ({
    posts,
    matched: 0,
    stocked: 0,
    generated: 0,
  }));
  runProvider.mockResolvedValue({
    output: { metadata: { json: { verdict: 'ALLOW', reason: 'fine', categories: [] } } },
  });
});

describe('planCarousel', () => {
  const thread = {
    actionable: true,
    directionOptions: [],
    restrictedTopicsMentioned: [],
    hookFramework: 'direct_listicle',
    posts: [
      { text: '3 bread tips:', imageQuery: 'bread on a board' },
      { text: 'Use a scale', imageQuery: '' },
      { text: 'Follow for more', imageQuery: '' },
    ],
  };

  it('writes the thread, picks pictures, checks safety and queues the render', async () => {
    generate.mockResolvedValue(thread);
    const { deps, db, queue } = makeDeps({
      metadata: { runId: 'run_1', carousel: storedCarousel([]) },
    });
    const project = await db.videoProject.findUnique();
    await planCarousel(data, deps, project as unknown as VideoProject, deps.logger);
    expect(fillCarouselPictures).toHaveBeenCalledTimes(1);
    const posts = fillCarouselPictures.mock.calls[0]?.[2] as Array<{
      text: string;
      imageQuery?: string;
    }>;
    expect(posts.map((p) => p.text)).toEqual(['3 bread tips:', 'Use a scale', 'Follow for more']);
    expect(posts[0]?.imageQuery).toBe('bread on a board');
    expect(runProvider).toHaveBeenCalledTimes(1); // the safety gate
    expect(generateSlideshowCopy).toHaveBeenCalledTimes(1);
    expect(states(db)).toEqual(['ASSETS_QUEUED']);
    expect(queue.add).toHaveBeenCalledWith('render-carousel', data, {
      jobId: 'render-carousel__prj_1__run_1',
    });
  });

  it('parks a vague brief in DRAFT with direction options', async () => {
    generate.mockResolvedValue({
      ...thread,
      actionable: false,
      directionOptions: ['Tips', 'Offer'],
      posts: [],
    });
    const { deps, db, queue } = makeDeps({
      metadata: { runId: 'run_1', carousel: storedCarousel([]) },
    });
    const project = await db.videoProject.findUnique();
    await planCarousel(data, deps, project as unknown as VideoProject, deps.logger);
    expect(states(db)).toEqual(['DRAFT']);
    const draft = firstArg(db.videoProject.updateMany, 0) as { data: { errorReason: string } };
    expect(draft.data.errorReason).toMatch(/^brief_too_vague/);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('parks restricted topics for confirmation', async () => {
    generate.mockResolvedValue({ ...thread, restrictedTopicsMentioned: ['alcohol'] });
    const { deps, db } = makeDeps({ metadata: { runId: 'run_1', carousel: storedCarousel([]) } });
    const project = await db.videoProject.findUnique();
    await planCarousel(data, deps, project as unknown as VideoProject, deps.logger);
    const draft = firstArg(db.videoProject.updateMany, 0) as { data: { errorReason: string } };
    expect(draft.data.errorReason).toMatch(/^restricted_topics/);
  });

  it('keeps a pasted thread (no writing) and fails the run when safety blocks it', async () => {
    runProvider.mockResolvedValue({
      output: { metadata: { json: { verdict: 'BLOCK', reason: 'hate', categories: [] } } },
    });
    const { deps, db, queue } = makeDeps({
      metadata: {
        runId: 'run_1',
        carousel: storedCarousel([{ id: 'p1', text: 'Pasted', image: null }]),
      },
    });
    const project = await db.videoProject.findUnique();
    await planCarousel(data, deps, project as unknown as VideoProject, deps.logger);
    expect(generate).not.toHaveBeenCalled();
    expect(states(db)).toEqual(['FAILED']);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('renderCarousel', () => {
  const metadata = {
    runId: 'run_1',
    carousel: storedCarousel([
      {
        id: 'p1',
        text: 'Hook',
        image: { imageId: 'img', width: 800, height: 600, aiGenerated: false },
      },
      { id: 'p2', text: 'Body', image: null },
      { id: 'p3', text: 'Follow', image: null },
    ]),
  };

  it('renders, stores the slides, records one carousel render and readies the review', async () => {
    const { deps, db, tx, storage } = makeDeps({ state: 'ASSETS_QUEUED', metadata });
    await renderCarousel(data, deps);
    expect(states(db)).toEqual(['RENDERING', 'QUALITY_CHECKING', 'READY_FOR_REVIEW']);
    expect(storage.put).toHaveBeenCalledTimes(6); // 3 slides × PNG + JPEG
    const render = firstArg(tx.videoRender.create, 0) as {
      data: {
        targetPlatform: string;
        qualityCheckState: string;
        composition: { slides: unknown[] };
      };
    };
    expect(render.data).toMatchObject({ targetPlatform: 'carousel', qualityCheckState: 'PASSED' });
    expect(render.data.composition.slides).toHaveLength(3);
    expect(autoApproveIfTrusted).toHaveBeenCalledTimes(1);
    expect(notifyGenerationComplete).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('ignores a stale run and fails a carousel without posts', async () => {
    const stale = makeDeps({ state: 'ASSETS_QUEUED', metadata: { ...metadata, runId: 'newer' } });
    await renderCarousel(data, stale.deps);
    expect(stale.db.videoProject.updateMany).not.toHaveBeenCalled();
    const empty = makeDeps({
      state: 'ASSETS_QUEUED',
      metadata: { runId: 'run_1', carousel: storedCarousel([]) },
    });
    await renderCarousel(data, empty.deps);
    expect(states(empty.db)).toEqual(['FAILED']);
  });

  it('fails the run with the error when the job gives up', async () => {
    const { deps, db } = makeDeps({ state: 'RENDERING', metadata });
    await onRenderCarouselFailed(data, deps, 'disk full');
    const failed = firstArg(db.videoProject.updateMany, 0) as { data: { errorReason: string } };
    expect(failed.data.errorReason).toBe('carousel_render_error: disk full');
  });
});
