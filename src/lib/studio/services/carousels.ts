import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, VideoProject, VideoProjectState } from '@prisma/client';
import { z } from 'zod';
import {
  ConflictError,
  NotFoundError,
  RateLimitError,
  UpstreamServiceError,
  ValidationError,
} from '../../errors';
import type { TenantContext } from '../../tenant';
import { brandLogoUploadId, carouselImages } from '../carousel/assets';
import { MAX_POSTS } from '../carousel/constants';
import {
  carouselEditInput,
  readCarousel,
  type CarouselCreateInput,
  type CarouselEditInput,
  type StoredCarousel,
  type StoredPost,
} from '../carousel/document';
import { parsePastedThread } from '../carousel/paste';
import { previewSlides, produceCarousel, type PreviewSlide } from '../carousel/produce';
import { carouselComposition, CAROUSEL_RENDER_PLATFORM } from '../carousel/publishing';
import type { SlideIssue } from '../carousel/quality';
import {
  loadThreadContext,
  projectTextGenerator,
  rewritePost,
  writeThread,
} from '../carousel/writer';
import { createZip } from '../export/zip';
import type { ProviderRunDeps } from '../pipeline/provider-run';
import { projectMetadata } from '../pipeline/project-state';
import { jobIds, type JobQueue } from '../queue/enqueue';
import type { ProjectJobData } from '../queue/queues';
import { providerOutputKey, type AssetStorage } from '../storage';
import { toPlanTier } from './catalog';

// 21.6 carousels behind /api/studio/projects/:id/carousel*: read, save, live preview, re-render,
// AI rewrite of one post or the whole thread, and the slides as a ZIP. The carousel lives in
// project.metadata.carousel (carousel/document.ts); renders are video_renders rows whose
// composition lists the slide images (carousel/publishing.ts).

type Db = PrismaClient;

/** States in which the owner may change the carousel (as for any project, projects.ts). */
export const CAROUSEL_EDITABLE_STATES: readonly VideoProjectState[] = [
  'DRAFT',
  'FAILED',
  'REJECTED',
  'QUALITY_FAILED',
  'READY_FOR_REVIEW',
];
/** States from which a saved carousel can be rendered again without a new generation. */
const RERENDER_STATES: readonly VideoProjectState[] = [
  'FAILED',
  'REJECTED',
  'QUALITY_FAILED',
  'READY_FOR_REVIEW',
];
/** AI rewrites (one post or the whole thread) per carousel, against runaway cost. */
export const MAX_CAROUSEL_REWRITES = 30;
const URL_TTL_SEC = 60 * 60;

const HANDLE_LIKE = /^@?([\p{L}\p{N}._]{1,30})$/u;

/** A handle from the business name: lower case letters and digits only (editable later). */
export function handleFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 30);
}

/**
 * The handle shown on the cards: the owner's, else a connected Instagram / TikTok / X account
 * name that looks like a handle, else one made from the business name.
 */
async function defaultHandle(
  db: Db,
  scope: { organisationId: string; businessId: string },
  businessName: string,
): Promise<string> {
  const connections = await db.platformConnection.findMany({
    where: {
      organisationId: scope.organisationId,
      businessId: scope.businessId,
      state: 'active',
      platform: { in: ['instagram', 'tiktok', 'x'] },
    },
    select: { platform: true, platformAccountName: true },
  });
  const order = ['instagram', 'tiktok', 'x'];
  const named = [...connections]
    .sort((a, b) => order.indexOf(a.platform) - order.indexOf(b.platform))
    .map((c) => HANDLE_LIKE.exec(c.platformAccountName.trim())?.[1])
    .find((h): h is string => Boolean(h));
  return named ?? handleFromName(businessName);
}

/** The carousel a new CAROUSEL project starts with (POST /projects). */
export async function initialCarousel(
  db: Db,
  input: {
    organisationId: string;
    businessId: string;
    brandKitId?: string | null;
    language: string;
    carousel: CarouselCreateInput;
  },
): Promise<StoredCarousel> {
  const scope = { organisationId: input.organisationId, businessId: input.businessId };
  const business = await db.business.findFirst({
    where: { id: input.businessId, organisationId: input.organisationId },
    select: { name: true },
  });
  const displayName = (business?.name ?? '').trim().slice(0, 50) || 'Business';
  const pasted = input.carousel.thread ? parsePastedThread(input.carousel.thread, MAX_POSTS) : [];
  return {
    version: 1,
    theme: input.carousel.theme,
    language: input.language,
    profile: {
      displayName,
      handle: input.carousel.handle ?? (await defaultHandle(db, scope, displayName)),
      logoUploadId: await brandLogoUploadId(db, scope, input.brandKitId),
    },
    posts: pasted.map((text): StoredPost => ({ id: randomUUID(), text, image: null })),
    postCount: pasted.length || input.carousel.postCount,
    aiWritten: false,
    rewrites: 0,
  };
}

async function carouselProject(db: Db, organisationId: string, id: string) {
  const project = await db.videoProject.findFirst({
    where: { id, organisationId, deletedAt: null },
  });
  if (!project) throw new NotFoundError('Project not found');
  const stored = readCarousel(project.metadata);
  if (project.sourceType !== 'CAROUSEL' || !stored)
    throw new ConflictError('This project is not a carousel');
  return { project, stored };
}

export interface CarouselRenderView {
  readonly id: string;
  readonly qualityCheckState: string;
  readonly createdAt: Date;
  readonly aiGenerated: boolean;
  readonly issues: CarouselIssue[];
  readonly slides: Array<{ index: number; pngUrl: string; postIds: string[] }>;
}

type CarouselIssue = { slide: number; code: string; detail: string };

export interface CarouselView {
  readonly projectId: string;
  readonly state: VideoProjectState;
  readonly editable: boolean;
  readonly canRerender: boolean;
  readonly rewritesLeft: number;
  readonly carousel: StoredCarousel;
  /** Preview URLs of the posts' pictures by image id. */
  readonly images: Record<string, string>;
  readonly render: CarouselRenderView | null;
}

async function latestRender(
  db: Db,
  storage: AssetStorage,
  project: Pick<VideoProject, 'id' | 'metadata'>,
): Promise<CarouselRenderView | null> {
  const ids = Object.values(
    (projectMetadata(project.metadata).renders as Record<string, string> | undefined) ?? {},
  );
  const render = await db.videoRender.findFirst({
    where: {
      projectId: project.id,
      targetPlatform: CAROUSEL_RENDER_PLATFORM,
      ...(ids.length > 0 && { id: { in: ids } }),
    },
    orderBy: { createdAt: 'desc' },
  });
  const composition = carouselComposition(render?.composition);
  if (!render || !composition) return null;
  return {
    id: render.id,
    qualityCheckState: render.qualityCheckState,
    createdAt: render.createdAt,
    aiGenerated: composition.aiGenerated,
    issues: composition.issues,
    slides: await Promise.all(
      composition.slides.map(async (s) => ({
        index: s.index,
        pngUrl: await storage.signedUrl(composition.bucket, s.pngKey, URL_TTL_SEC),
        postIds: s.postIds,
      })),
    ),
  };
}

async function imageUrls(
  db: Db,
  storage: AssetStorage,
  organisationId: string,
  posts: readonly StoredPost[],
): Promise<Record<string, string>> {
  const ids = posts.flatMap((p) => (p.image ? [p.image.imageId] : []));
  if (ids.length === 0) return {};
  const rows = await db.imageLibraryItem.findMany({
    where: { id: { in: ids }, organisationId },
    select: { id: true, s3Bucket: true, s3Key: true },
  });
  const entries = await Promise.all(
    rows
      .filter((r) => r.s3Key)
      .map(async (r): Promise<[string, string]> => [
        r.id,
        await storage.signedUrl(r.s3Bucket, r.s3Key, URL_TTL_SEC),
      ]),
  );
  return Object.fromEntries(entries);
}

function viewOf(
  project: VideoProject,
  stored: StoredCarousel,
  images: Record<string, string>,
  render: CarouselRenderView | null,
): CarouselView {
  return {
    projectId: project.id,
    state: project.state,
    editable: CAROUSEL_EDITABLE_STATES.includes(project.state),
    canRerender: render !== null && RERENDER_STATES.includes(project.state),
    rewritesLeft: Math.max(0, MAX_CAROUSEL_REWRITES - stored.rewrites),
    carousel: stored,
    images,
    render,
  };
}

/** GET /projects/:id/carousel. */
export async function getCarousel(
  deps: { db: Db; storage: AssetStorage },
  organisationId: string,
  id: string,
): Promise<CarouselView> {
  const { project, stored } = await carouselProject(deps.db, organisationId, id);
  return viewOf(
    project,
    stored,
    await imageUrls(deps.db, deps.storage, organisationId, stored.posts),
    await latestRender(deps.db, deps.storage, project),
  );
}

/** The edited carousel as it will be stored (pictures looked up in the business's library). */
async function applyEdit(
  db: Db,
  project: VideoProject,
  stored: StoredCarousel,
  input: CarouselEditInput,
): Promise<StoredCarousel> {
  const records = await carouselImages(
    db,
    { organisationId: project.organisationId, businessId: project.businessId },
    input.posts.flatMap((p) => (p.imageId ? [p.imageId] : [])),
  );
  const previous = new Map(stored.posts.map((p) => [p.id, p]));
  return {
    ...stored,
    theme: input.theme,
    profile: {
      ...stored.profile,
      displayName: input.profile.displayName,
      handle: input.profile.handle,
    },
    posts: input.posts.map((p) => ({
      id: p.id,
      text: p.text,
      image: p.imageId ? (records.get(p.imageId) ?? null) : null,
      ...(previous.get(p.id)?.imageQuery && { imageQuery: previous.get(p.id)?.imageQuery }),
    })),
  };
}

async function writeCarousel(db: Db, project: VideoProject, next: StoredCarousel): Promise<void> {
  const metadata = projectMetadata(project.metadata);
  const updated = await db.videoProject.updateMany({
    where: { id: project.id, state: project.state, updatedAt: project.updatedAt },
    data: { metadata: { ...metadata, carousel: next } as unknown as Prisma.InputJsonValue },
  });
  if (updated.count === 0)
    throw new ConflictError('Project changed concurrently; reload and retry');
}

function assertEditable(project: VideoProject): void {
  if (!CAROUSEL_EDITABLE_STATES.includes(project.state))
    throw new ConflictError(`The carousel cannot be edited while the project is ${project.state}`);
}

/** PUT /projects/:id/carousel. */
export async function saveCarousel(
  deps: { db: Db; storage: AssetStorage },
  organisationId: string,
  id: string,
  input: z.infer<typeof carouselEditInput>,
): Promise<CarouselView> {
  const { project, stored } = await carouselProject(deps.db, organisationId, id);
  assertEditable(project);
  const next = await applyEdit(deps.db, project, stored, input);
  await writeCarousel(deps.db, project, next);
  return getCarousel(deps, organisationId, id);
}

export interface CarouselPreview {
  readonly slides: PreviewSlide[];
  readonly issues: SlideIssue[];
  readonly removedCharacters: number;
}

/** POST /projects/:id/carousel/preview: render the unsaved edit to small JPEGs (nothing stored). */
export async function previewCarousel(
  deps: { db: Db; storage: AssetStorage },
  organisationId: string,
  id: string,
  input: CarouselEditInput,
): Promise<CarouselPreview> {
  const { project, stored } = await carouselProject(deps.db, organisationId, id);
  const next = await applyEdit(deps.db, project, stored, input);
  const produced = await produceCarousel(
    deps,
    { organisationId, businessId: project.businessId },
    next,
  );
  return {
    slides: await previewSlides(produced),
    issues: [...produced.issues],
    removedCharacters: produced.prepared.removedCharacters,
  };
}

/**
 * POST /projects/:id/carousel/render: render the saved carousel again after an edit. No AI is
 * used, so no allowance is taken (the carousel was counted when it was generated).
 */
export async function rerenderCarousel(
  deps: { db: Db; queue: JobQueue },
  tenant: Pick<TenantContext, 'organisationId' | 'organisation'>,
  id: string,
): Promise<{ runId: string }> {
  const { project, stored } = await carouselProject(deps.db, tenant.organisationId, id);
  if (!RERENDER_STATES.includes(project.state))
    throw new ConflictError(
      `The carousel cannot be rendered while the project is ${project.state}`,
    );
  if (stored.posts.length === 0) throw new ConflictError('The carousel has no posts yet');
  const rendered = await deps.db.videoRender.count({
    where: { projectId: project.id, targetPlatform: CAROUSEL_RENDER_PLATFORM },
  });
  if (rendered === 0) throw new ConflictError('Generate the carousel first');
  const runId = randomUUID();
  const planTier = toPlanTier(tenant.organisation.planTier);
  const metadata = projectMetadata(project.metadata);
  const moved = await deps.db.videoProject.updateMany({
    where: { id: project.id, state: project.state, updatedAt: project.updatedAt },
    data: {
      state: 'ASSETS_QUEUED',
      errorReason: null,
      completedAt: null,
      metadata: { ...metadata, runId, planTier, renders: {} } as Prisma.InputJsonValue,
    },
  });
  if (moved.count === 0) throw new ConflictError('Project changed concurrently; reload and retry');
  const job: ProjectJobData = {
    projectId: project.id,
    organisationId: tenant.organisationId,
    runId,
    planTier,
  };
  try {
    await deps.queue.add('render-carousel', job, { jobId: jobIds.renderCarousel(job) });
  } catch (err) {
    await deps.db.videoProject.updateMany({
      where: { id: project.id, state: 'ASSETS_QUEUED' },
      data: {
        state: project.state,
        errorReason: project.errorReason,
        metadata: (project.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
    throw new UpstreamServiceError('The render could not be queued; try again shortly', {
      cause: err instanceof Error ? err.message : 'queue_unavailable',
    });
  }
  return { runId };
}

export const rewriteCarouselInput = z
  .object({
    /** The post to rewrite; absent = the whole thread. */
    postId: z.string().trim().min(1).max(64).optional(),
    instruction: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/**
 * POST /projects/:id/carousel/rewrite: Claude rewrites one post (or writes the thread again) from
 * the brief, brand voice and restricted topics, through the router (cost-tracked, capped).
 * Pictures stay where they are; a rewritten thread keeps the pictures of posts at the same place.
 */
export async function rewriteCarousel(
  deps: { db: Db; storage: AssetStorage; providers: ProviderRunDeps; now: () => number },
  tenant: Pick<TenantContext, 'organisationId' | 'organisation'>,
  id: string,
  input: z.infer<typeof rewriteCarouselInput>,
): Promise<CarouselView> {
  const { project, stored } = await carouselProject(deps.db, tenant.organisationId, id);
  assertEditable(project);
  if (stored.rewrites >= MAX_CAROUSEL_REWRITES)
    throw new RateLimitError(
      `This carousel has used its ${MAX_CAROUSEL_REWRITES} AI rewrites; edit the text yourself`,
      3_600,
    );
  const context = await loadThreadContext(deps.db, project, deps.now());
  const generate = projectTextGenerator(deps.providers, {
    organisationId: tenant.organisationId,
    projectId: project.id,
    planTier: toPlanTier(tenant.organisation.planTier),
  });
  const brief = project.description?.trim() || stored.posts[0]?.text || '';
  let posts: StoredPost[];
  if (input.postId) {
    const index = stored.posts.findIndex((p) => p.id === input.postId);
    if (index < 0) throw new NotFoundError('Post not found');
    const text = await rewritePost(generate, {
      ...context,
      brief,
      posts: stored.posts.map((p) => p.text),
      index,
      ...(input.instruction && { instruction: input.instruction }),
    });
    posts = stored.posts.map((p, i) => (i === index ? { ...p, text } : p));
  } else {
    const thread = await writeThread(generate, {
      ...context,
      brief: input.instruction ? `${brief}\n\n${input.instruction}` : brief,
      postCount: stored.posts.length || stored.postCount,
      directionChosen: true,
      restrictedTopicsConfirmed:
        projectMetadata(project.metadata).restrictedTopicsConfirmed === true,
    });
    if (thread.posts.length === 0)
      throw new ValidationError('The brief is too vague to write a thread; add more detail');
    posts = thread.posts.map((p, i) => ({
      id: stored.posts[i]?.id ?? randomUUID(),
      text: p.text,
      image: stored.posts[i]?.image ?? null,
      ...(p.imageQuery && { imageQuery: p.imageQuery }),
    }));
  }
  const fresh = await carouselProject(deps.db, tenant.organisationId, id);
  await writeCarousel(deps.db, fresh.project, {
    ...fresh.stored,
    posts,
    aiWritten: true,
    rewrites: fresh.stored.rewrites + 1,
  });
  return getCarousel(deps, tenant.organisationId, id);
}

/**
 * POST /projects/:id/carousel/download: every slide of the latest render as PNGs in one ZIP,
 * kept next to the slides and handed out as a short-lived signed URL.
 */
export async function carouselDownload(
  deps: { db: Db; storage: AssetStorage },
  organisationId: string,
  id: string,
): Promise<{ url: string; fileName: string }> {
  const zip = await carouselZip(deps, organisationId, id);
  const key = providerOutputKey({
    organisationId,
    projectId: id,
    providerId: 'carousel',
    extension: 'zip',
    id: zip.renderId,
  });
  await deps.storage.put({
    bucket: zip.bucket,
    key,
    body: zip.bytes,
    contentType: 'application/zip',
  });
  return {
    url: await deps.storage.signedUrl(zip.bucket, key, URL_TTL_SEC),
    fileName: zip.fileName,
  };
}

/** Every slide of the latest render as PNGs in a ZIP. */
export async function carouselZip(
  deps: { db: Db; storage: AssetStorage },
  organisationId: string,
  id: string,
): Promise<{ fileName: string; bytes: Uint8Array; bucket: string; renderId: string }> {
  const { project } = await carouselProject(deps.db, organisationId, id);
  const render = await deps.db.videoRender.findFirst({
    where: { projectId: project.id, targetPlatform: CAROUSEL_RENDER_PLATFORM },
    orderBy: { createdAt: 'desc' },
  });
  const composition = carouselComposition(render?.composition);
  if (!composition) throw new NotFoundError('The carousel has not been rendered yet');
  const entries = [];
  for (const slide of composition.slides) {
    const size = await deps.storage.size(composition.bucket, slide.pngKey);
    entries.push({
      name: `slide-${String(slide.index + 1).padStart(2, '0')}.png`,
      data: await deps.storage.readRange(composition.bucket, slide.pngKey, 0, size - 1),
    });
  }
  return {
    fileName: `carousel-${project.id}.zip`,
    bytes: createZip(entries),
    bucket: composition.bucket,
    renderId: render?.id ?? project.id,
  };
}
