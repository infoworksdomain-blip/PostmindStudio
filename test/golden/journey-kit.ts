import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { expect } from 'vitest';
import * as approveRoute from '../../src/app/api/studio/projects/[id]/approve/route';
import * as generateRoute from '../../src/app/api/studio/projects/[id]/generate/route';
import * as projectRendersRoute from '../../src/app/api/studio/projects/[id]/renders/route';
import * as projectRoute from '../../src/app/api/studio/projects/[id]/route';
import * as projectsRoute from '../../src/app/api/studio/projects/route';
import * as publicationRoute from '../../src/app/api/studio/publications/[id]/route';
import * as publicationsRoute from '../../src/app/api/studio/publications/route';
import { sealTokens } from '../../src/lib/studio/platforms/tokens';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import type { TenantContext } from '../../src/lib/tenant';
import { call, installApi, tenant } from '../helpers/api-harness';
import { createHarness, type HarnessOptions } from '../helpers/pipeline-harness';

// Shared plumbing for the golden-path journeys (BACKLOG 12.7): one organisation per journey,
// the real route handlers in front of the real workers (inline queue), scripted providers and
// recording publishers behind them, and a single cleanup keyed on this run's org prefix.

export const RUN = randomUUID().slice(0, 8);
export const ORG_PREFIX = `golden-${RUN}`;
export const LIBRARY_URL_PREFIX = `https://golden-corpus.example/${RUN}/`;
export const BUSINESS_ID = 'biz-golden';

export type Project = {
  id: string;
  state: string;
  errorReason: string | null;
  costActualPence: number;
};
export type Render = {
  id: string;
  targetPlatform: string;
  aspectRatio: string;
  qualityCheckState: string;
};
export type Publication = { id: string; state: string; platformPostId: string | null };

export type Journey = ReturnType<typeof startJourney>;

export const fakePostId = (platform: string, journey: string, n: number) =>
  `fake_${platform}_${RUN}_${journey}_${n}`;

/** A fresh harness + API install for one journey, owned by its own organisation. */
export function startJourney(
  db: PrismaClient,
  id: string,
  options: HarnessOptions = {},
  extraTokens: Record<string, TenantContext> = {},
) {
  const org = `${ORG_PREFIX}-${id}`;
  const h = createHarness(db, options);
  // Post ids are unique per (platform, platformPostId) across the whole table, so each
  // journey's recording publishers mint ids no other journey (or earlier run) can collide with.
  for (const publisher of Object.values(h.publishers)) {
    publisher.behaviour = () => ({
      platformPostId: fakePostId(publisher.platform, id, publisher.published.length),
      platformUrl: `https://fake.invalid/${publisher.platform}/${publisher.published.length}`,
      metadata: { fake: true },
    });
  }
  const api = installApi(
    db,
    { owner: tenant(org), reader: tenant(org, ['studio:project:read']), ...extraTokens },
    { queue: h.queue, publishing: h.deps.publishing, pipeline: h.deps },
  );
  return { db, org, h, api };
}

export async function drain(j: Journey, options: { expectClean?: boolean } = {}) {
  const result = await drainInline(j.h.queue, j.h.deps);
  if (options.expectClean ?? true) expect(result.failedJobs).toEqual([]);
  return result;
}

export const briefBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Leeds Sourdough launch',
  businessId: BUSINESS_ID,
  brief: { rawInput: 'Launch video for our sourdough subscription', callToAction: 'Subscribe' },
  targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 15 }],
  ...overrides,
});

export async function createProject(j: Journey, body: Record<string, unknown> = briefBody()) {
  const res = await call(projectsRoute.POST, { method: 'POST', token: 'owner', body });
  expect(res.status).toBe(201);
  return (res.json.project as Project).id;
}

export async function getProject(j: Journey, id: string): Promise<Project> {
  const res = await call(projectRoute.GET, { token: 'reader', params: { id } });
  expect(res.status).toBe(200);
  return res.json.project as Project;
}

/** POST /generate then run every queued job; returns the project as the user would see it. */
export async function generate(j: Journey, id: string, options: { expectClean?: boolean } = {}) {
  const res = await call(generateRoute.POST, {
    method: 'POST',
    token: 'owner',
    params: { id },
    body: {},
  });
  expect(res.status).toBe(202);
  await drain(j, options);
  return getProject(j, id);
}

export async function rendersOf(j: Journey, id: string): Promise<Render[]> {
  const res = await call(projectRendersRoute.GET, { token: 'reader', params: { id } });
  expect(res.status).toBe(200);
  return res.json.data as Render[];
}

export async function approve(j: Journey, id: string, note = 'Looks great') {
  const res = await call(approveRoute.POST, {
    method: 'POST',
    token: 'owner',
    params: { id },
    body: { note },
  });
  expect(res.status).toBe(200);
  expect((res.json.project as Project).state).toBe('APPROVED');
}

/** A Studio-held OAuth connection (TikTok / YouTube / X / LinkedIn), tokens sealed per org. */
export async function connect(j: Journey, platform: string, scopes = ['publish']) {
  const sealed = await sealTokens(j.h.keys, j.org, platform, {
    accessToken: `${platform}-access`,
    refreshToken: `${platform}-refresh`,
    expiresAt: new Date(Date.now() + 3_600_000),
    scopes,
  });
  return j.db.platformConnection.create({
    data: {
      organisationId: j.org,
      businessId: BUSINESS_ID,
      platform,
      platformAccountId: `${platform}-acct-${randomUUID()}`,
      platformAccountName: 'Leeds Sourdough',
      ...sealed,
      scopes,
      state: 'active',
      connectedByUserId: 'user-1',
    },
  });
}

export async function publish(j: Journey, body: Record<string, unknown>) {
  const res = await call(publicationsRoute.POST, { method: 'POST', token: 'owner', body });
  expect(res.status).toBe(202);
  return (res.json.publication as Publication).id;
}

export async function getPublication(j: Journey, id: string): Promise<Publication> {
  const res = await call(publicationRoute.GET, { token: 'reader', params: { id } });
  expect(res.status).toBe(200);
  return res.json.publication as Publication;
}

/** Brief → generate → review → approve, the prefix most publishing journeys share. */
export async function approvedTikTokProject(j: Journey) {
  const id = await createProject(j);
  expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
  await approve(j, id);
  const [render] = await rendersOf(j, id);
  if (!render) throw new Error('expected a render');
  return { projectId: id, render };
}

/** Remove everything this run created (children first; the schema has no cascades). */
export async function cleanupGolden(db: PrismaClient, since: Date) {
  const org = { startsWith: ORG_PREFIX };
  const projectIds = (
    await db.videoProject.findMany({ where: { organisationId: org }, select: { id: true } })
  ).map((p) => p.id);
  const inProjects = { projectId: { in: projectIds } };
  const pubIds = (
    await db.videoPublication.findMany({ where: inProjects, select: { id: true } })
  ).map((p) => p.id);
  const shotIds = (
    await db.videoShot.findMany({ where: { script: inProjects }, select: { id: true } })
  ).map((s) => s.id);
  const renderIds = (
    await db.videoRender.findMany({ where: inProjects, select: { id: true } })
  ).map((r) => r.id);
  const businessIds = (
    await db.websiteScan.findMany({ where: { organisationId: org }, select: { businessId: true } })
  ).map((s) => s.businessId);

  await db.videoAnalytic.deleteMany({ where: { publicationId: { in: pubIds } } });
  await db.scheduledPublication.deleteMany({ where: { publicationId: { in: pubIds } } });
  await db.videoPublication.deleteMany({ where: { id: { in: pubIds } } });
  await db.textOverlay.deleteMany({
    where: { OR: [{ shotId: { in: shotIds } }, { renderId: { in: renderIds } }] },
  });
  await db.slideshowSlide.deleteMany({ where: inProjects });
  await db.videoShot.deleteMany({ where: { id: { in: shotIds } } });
  await db.videoScript.deleteMany({ where: inProjects });
  await db.videoBrief.deleteMany({ where: inProjects });
  await db.videoRender.deleteMany({ where: { id: { in: renderIds } } });
  await db.videoAsset.deleteMany({ where: inProjects });
  await db.approvalTask.deleteMany({ where: inProjects });
  await db.videoProject.deleteMany({ where: { id: { in: projectIds } } });

  await db.platformConnection.deleteMany({ where: { organisationId: org } });
  await db.brandKit.deleteMany({ where: { organisationId: org } });
  await db.overlayPreset.deleteMany({ where: { organisationId: org } });
  await db.slideshowTemplate.deleteMany({ where: { organisationId: org } });
  await db.imageLibraryQuery.deleteMany({ where: { businessId: { in: businessIds } } });
  await db.imageLibraryItem.deleteMany({ where: { organisationId: org } });
  await db.businessProfile.deleteMany({ where: { organisationId: org } });
  await db.websiteScan.deleteMany({ where: { organisationId: org } });
  await db.providerJob.deleteMany({ where: { organisationId: org } });
  await db.providerUsage.deleteMany({ where: { organisationId: org } });
  await db.systemFlag.deleteMany({ where: { key: { contains: ORG_PREFIX } } });

  const items = (
    await db.videoLibraryItem.findMany({
      where: { sourceUrl: { startsWith: LIBRARY_URL_PREFIX } },
      select: { id: true },
    })
  ).map((i) => i.id);
  await db.$executeRaw`DELETE FROM studio.video_library_embeddings WHERE "libraryItemId" = ANY(${items})`;
  await db.videoLibraryAnalysis.deleteMany({ where: { libraryItemId: { in: items } } });
  await db.videoLibraryLicense.deleteMany({ where: { libraryItemId: { in: items } } });
  await db.videoLibraryItem.deleteMany({ where: { id: { in: items } } });
  // Library ingest bills the platform org; only remove the rows this run created.
  await db.providerJob.deleteMany({
    where: { organisationId: 'postmind-platform', startedAt: { gte: since } },
  });
}
