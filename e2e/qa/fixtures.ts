import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { PrismaClient, type Prisma } from '@prisma/client';

// Shared fixtures for the QA specs in e2e/qa: Prisma-seeded organisation, members in every role,
// projects in every state, renders, publications and platform connections. Nothing here calls a
// provider or a social platform: object storage is the local stub (e2e/qa/s3-stub.mjs).

export const ROLES = ['owner', 'admin', 'publisher', 'creator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const run = randomUUID().slice(0, 8);
export const password = `Qa3-${randomUUID()}`;
export const emailFor = (role: string): string => `qa3-${role}-${run}@example.test`;

export interface World {
  orgId: string;
  businessId: string;
  /** A second organisation with no projects at all (empty states). */
  emptyOrgId: string;
  projects: Record<string, string>;
  connections: { tiktok: string; youtube: string; broken: string };
  renders: Record<string, string[]>;
  publications: Record<string, string>;
}

/**
 * Auth endpoints are rate limited per client address (3 sign-ups and 5 sign-ins a minute); the app
 * reads X-Real-IP (src/lib/auth/config.ts), so each call presents its own address.
 */
let nextHost = 1;
function freshClient(baseURL: string): Record<string, string> {
  nextHost += 1;
  return {
    origin: baseURL,
    'x-real-ip': `10.${Math.floor(nextHost / 250) % 250}.${Math.floor(Math.random() * 250)}.${nextHost % 250}`,
  };
}

const CONNECTION_CLOSED =
  /closed the connection|unexpected message from server|P1017|P1001|Can't reach database server/;

/**
 * A Prisma client that retries a query whose connection the database dropped. Real Postgres never
 * does; the single-session PGlite used for local runs (npm run db:local) can when the app and the
 * spec query at the same moment.
 */
export function newDb() {
  return new PrismaClient().$extends({
    query: {
      async $allOperations({ args, query }) {
        for (let attempt = 1; ; attempt += 1) {
          try {
            return await query(args);
          } catch (err) {
            if (attempt >= 20 || !CONNECTION_CLOSED.test(String(err))) throw err;
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        }
      },
    },
  });
}

export type Db = ReturnType<typeof newDb>;

/** Sign a user up through the real auth API and mark the address verified (no inbox here). */
export async function createUser(
  request: APIRequestContext,
  db: Db,
  baseURL: string,
  email: string,
  name: string,
): Promise<string> {
  const res = await request.post('/api/auth/sign-up/email', {
    headers: freshClient(baseURL),
    data: { name, email, password },
  });
  expect(res.ok(), `sign-up ${email}: ${res.status()}`).toBeTruthy();
  await db.user.updateMany({ where: { email }, data: { emailVerified: true } });
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  return user.id;
}

/** A browser page signed in as `email` through the real sign-in API (cookies in the context). */
export async function signedInPage(
  browser: Browser,
  baseURL: string,
  email: string,
  opts: { viewport?: { width: number; height: number }; locale?: string } = {},
): Promise<Page> {
  const context = await browser.newContext({
    baseURL,
    locale: opts.locale ?? 'en-GB',
    ...(opts.viewport && { viewport: opts.viewport }),
  });
  const res = await context.request.post('/api/auth/sign-in/email', {
    headers: freshClient(baseURL),
    data: { email, password },
  });
  expect(res.ok(), `sign-in ${email}: ${res.status()}`).toBeTruthy();
  return context.newPage();
}

const TARGETS = [
  { platform: 'tiktok', aspectRatio: '9:16', duration: 20 },
  { platform: 'youtube_short', aspectRatio: '9:16', duration: 20 },
];

interface ProjectSpec {
  key: string;
  state: Prisma.VideoProjectCreateInput['state'];
  name: string;
  renders?: Array<'PASSED' | 'FAILED' | 'FORCE_APPROVED' | 'PENDING'>;
  errorReason?: string;
  metadata?: Prisma.InputJsonValue;
}

/** One project per state the UI treats differently. */
const PROJECT_SPECS: ProjectSpec[] = [
  { key: 'draft', state: 'DRAFT', name: 'QA Draft video' },
  { key: 'queued', state: 'QUEUED', name: 'QA Queued video' },
  { key: 'rendering', state: 'RENDERING', name: 'QA Rendering video' },
  {
    key: 'review',
    state: 'READY_FOR_REVIEW',
    name: 'QA Review video',
    renders: ['PASSED', 'PASSED'],
  },
  { key: 'review2', state: 'READY_FOR_REVIEW', name: 'QA Review reject', renders: ['PASSED'] },
  { key: 'review3', state: 'READY_FOR_REVIEW', name: 'QA Review roles', renders: ['PASSED'] },
  { key: 'review4', state: 'READY_FOR_REVIEW', name: 'QA Review workflow', renders: ['PASSED'] },
  { key: 'qfailed', state: 'QUALITY_FAILED', name: 'QA Quality failed', renders: ['FAILED'] },
  { key: 'approved', state: 'APPROVED', name: 'QA Approved video', renders: ['PASSED', 'PASSED'] },
  { key: 'approved2', state: 'APPROVED', name: 'QA Approved schedule', renders: ['PASSED'] },
  { key: 'published', state: 'PUBLISHED', name: 'QA Published video', renders: ['PASSED'] },
  {
    key: 'partial',
    state: 'PARTIALLY_PUBLISHED',
    name: 'QA Partly published',
    renders: ['PASSED'],
  },
  {
    key: 'failed',
    state: 'FAILED',
    name: 'QA Failed video',
    errorReason: 'runway/provider_unavailable: upstream answered 503',
  },
  {
    key: 'rejected',
    state: 'REJECTED',
    name: 'QA Rejected video',
    errorReason: 'Rejected: too long',
  },
];

export const FILLER_COUNT = 24;

export async function seedWorld(db: Db, ownerId: string): Promise<World> {
  const slug = `qa3-${run}`;
  const mkOrg = (id: string, name: string) =>
    db.organization.create({
      data: {
        id,
        name,
        slug: `${slug}-${id.startsWith('orgempty') ? 'empty' : 'main'}`,
        country: 'GB',
      },
    });
  const orgId = `org_${run}`;
  const emptyOrgId = `orgempty_${run}`;
  await mkOrg(orgId, `QA3 Studio ${run}`);
  await mkOrg(emptyOrgId, `QA3 Empty ${run}`);
  // A STANDARD plan so publishing and multi-step approval workflows are open (the access gate
  // answers 402 plan_required without one).
  await db.orgEntitlement.create({
    data: { organisationId: orgId, tier: 'STANDARD', access: 'full', source: 'stripe' },
  });
  const business = await db.business.create({
    data: { organisationId: orgId, name: 'QA Bakery', createdByUserId: ownerId },
  });
  const businessId = business.id;
  await db.business.create({
    data: { organisationId: emptyOrgId, name: 'QA Empty Co', createdByUserId: ownerId },
  });

  const mkConn = (platform: string, account: string, state: string) =>
    db.platformConnection.create({
      data: {
        organisationId: orgId,
        businessId,
        platform,
        platformAccountId: `${platform}-${account}-${run}`,
        platformAccountName: `QA ${platform} ${account}`,
        encryptedAccessToken: 'qa-dummy-not-a-token',
        scopes: [],
        state,
        connectedByUserId: ownerId,
        connectedVia: 'studio',
      },
    });
  const tiktok = await mkConn('tiktok', 'main', 'active');
  const youtube = await mkConn('youtube', 'main', 'active');
  const broken = await mkConn('x', 'old', 'needs_reconnect');

  const projects: Record<string, string> = {};
  const renders: Record<string, string[]> = {};
  const now = Date.now();
  let i = 0;
  for (const spec of PROJECT_SPECS) {
    i += 1;
    const project = await db.videoProject.create({
      data: {
        organisationId: orgId,
        businessId,
        createdByUserId: ownerId,
        name: spec.name,
        state: spec.state,
        sourceType: 'BRIEF',
        targetFormats: TARGETS,
        errorReason: spec.errorReason ?? null,
        costActualPence: 120 + i,
        costBudgetPence: 5000,
        createdAt: new Date(now - i * 60_000),
        ...(spec.metadata && { metadata: spec.metadata }),
        brief: {
          create: {
            rawInput: 'Fresh sourdough every morning',
            hook: 'Warm bread, no queue',
            keyMessage: 'Order ahead, collect fresh',
            targetAudience: 'Local commuters',
            tone: 'warm',
            keywords: ['bread'],
            ideationModel: 'qa:seed',
          },
        },
      },
    });
    projects[spec.key] = project.id;
    renders[spec.key] = [];
    if (!spec.renders) continue;
    const script = await db.videoScript.create({
      data: {
        projectId: project.id,
        targetPlatform: 'tiktok',
        targetAspectRatio: '9:16',
        targetDurationSec: 20,
        fullText: 'Fresh bread every morning. Order ahead.',
        scriptModel: 'qa:seed',
        shots: {
          create: [
            {
              sortOrder: 0,
              durationSec: 8,
              visualTreatment: 'TEXT_CARD',
              sceneDescription: 'Title card',
              voiceoverText: 'Fresh bread every morning.',
              onScreenText: 'Fresh bread',
              state: 'READY',
            },
            {
              sortOrder: 1,
              durationSec: 12,
              visualTreatment: 'IMAGE_STILL',
              sceneDescription: 'Loaves on a rack',
              voiceoverText: 'Order ahead.',
              onScreenText: 'Order ahead',
              state: 'READY',
            },
          ],
        },
      },
    });
    for (const [n, quality] of spec.renders.entries()) {
      const target = TARGETS[n % TARGETS.length]!;
      const render = await db.videoRender.create({
        data: {
          projectId: project.id,
          scriptId: script.id,
          targetPlatform: target.platform,
          aspectRatio: target.aspectRatio,
          resolution: '1080x1920',
          durationSec: 20,
          fps: 30,
          bitrateKbps: 4000,
          s3Bucket: 'ci-renders',
          s3Key: `qa3/${run}/${project.id}-${n}.mp4`,
          thumbnailS3Key: `qa3/${run}/${project.id}-${n}.jpg`,
          qualityCheckState: quality,
          qualityIssues:
            quality === 'FAILED'
              ? [
                  {
                    code: 'black_frames',
                    status: 'failed',
                    severity: 'error',
                    detail: 'Black frames at 1.2 s.',
                  },
                ]
              : [
                  {
                    code: 'duration_match',
                    status: 'passed',
                    severity: 'info',
                    detail: 'Rendered 20 s.',
                  },
                ],
          costPence: 40,
        },
      });
      renders[spec.key]!.push(render.id);
    }
  }

  // Pagination: more projects than one page (20).
  await db.videoProject.createMany({
    data: Array.from({ length: FILLER_COUNT }, (_, n) => ({
      organisationId: orgId,
      businessId,
      createdByUserId: ownerId,
      name: `QA Filler ${String(n).padStart(2, '0')}`,
      state: 'DRAFT' as const,
      sourceType: 'BRIEF' as const,
      targetFormats: TARGETS,
      createdAt: new Date(now - (100 + n) * 60_000),
    })),
  });

  // Publications in every state, on the "published", "partial" and "approved" projects.
  const publications: Record<string, string> = {};
  const mkPub = async (
    key: string,
    projectKey: string,
    renderIndex: number,
    data: Omit<
      Prisma.VideoPublicationUncheckedCreateInput,
      'organisationId' | 'projectId' | 'renderId' | 'platformAccountId'
    >,
  ) => {
    const pub = await db.videoPublication.create({
      data: {
        organisationId: orgId,
        projectId: projects[projectKey]!,
        renderId: renders[projectKey]![renderIndex]!,
        platformAccountId: `${data.platform}-main-${run}`,
        ...data,
      },
    });
    publications[key] = pub.id;
  };
  const inAWeek = new Date(now + 7 * 86_400_000);
  await mkPub('live', 'published', 0, {
    platform: 'tiktok',
    state: 'PUBLISHED',
    platformPostId: `tt-${run}-1`,
    platformUrl: 'https://www.tiktok.com/@qa/video/1',
    publishedAt: new Date(now - 3_600_000),
    caption: 'Live post',
  });
  await mkPub('scheduled', 'partial', 0, {
    platform: 'tiktok',
    state: 'SCHEDULED',
    scheduledFor: inAWeek,
    caption: 'Scheduled post',
  });
  await mkPub('failed', 'partial', 0, {
    platform: 'youtube_short',
    state: 'FAILED',
    errorReason: 'youtube_short/needs_reconnect: access token expired',
    errorCode: 'needs_reconnect',
    caption: 'Failed post',
  });
  await mkPub('failed2', 'published', 0, {
    platform: 'youtube_short',
    state: 'FAILED',
    errorReason: 'youtube_short/unavailable: connect ECONNREFUSED',
    errorCode: 'unavailable',
    caption: 'Failed raw reason',
  });
  await mkPub('cancelled', 'published', 0, {
    platform: 'x',
    state: 'CANCELLED',
    scheduledFor: inAWeek,
    caption: 'Cancelled post',
  });
  await mkPub('takendown', 'partial', 0, {
    platform: 'tiktok',
    state: 'TAKEN_DOWN',
    platformPostId: `tt-${run}-2`,
    publishedAt: new Date(now - 86_400_000),
    caption: 'Taken down',
  });
  await mkPub('publishing', 'partial', 0, {
    platform: 'youtube_short',
    state: 'PUBLISHING',
    caption: 'In flight',
  });
  await mkPub('scheduled2', 'published', 0, {
    platform: 'tiktok',
    state: 'SCHEDULED',
    scheduledFor: new Date(now + 3 * 86_400_000),
    caption: 'Scheduled to cancel',
  });
  await db.scheduledPublication.createMany({
    data: [
      { publicationId: publications.scheduled!, scheduledFor: inAWeek, state: 'PENDING' },
      {
        publicationId: publications.scheduled2!,
        scheduledFor: new Date(now + 3 * 86_400_000),
        state: 'PENDING',
      },
    ],
  });

  return {
    orgId,
    businessId,
    emptyOrgId,
    projects,
    connections: { tiktok: tiktok.id, youtube: youtube.id, broken: broken.id },
    renders,
    publications,
  };
}

export async function addMember(
  db: Db,
  organizationId: string,
  userId: string,
  role: string,
): Promise<void> {
  await db.member.create({
    data: { id: `mem_${randomUUID().slice(0, 12)}`, organizationId, userId, role },
  });
}

/** Everything the seed created, so repeated local runs leave the shared database clean. */
export async function cleanWorld(db: Db, world: World | undefined): Promise<void> {
  if (!world) return;
  const orgIds = [world.orgId, world.emptyOrgId];
  const projectIds = (
    await db.videoProject.findMany({
      where: { organisationId: { in: orgIds } },
      select: { id: true },
    })
  ).map((p) => p.id);
  const pubIds = (
    await db.videoPublication.findMany({
      where: { projectId: { in: projectIds } },
      select: { id: true },
    })
  ).map((p) => p.id);
  await db.scheduledPublication.deleteMany({ where: { publicationId: { in: pubIds } } });
  await db.videoPublication.deleteMany({ where: { id: { in: pubIds } } });
  await db.approvalTask.deleteMany({ where: { projectId: { in: projectIds } } });
  await db.videoRender.deleteMany({ where: { projectId: { in: projectIds } } });
  const scripts = (
    await db.videoScript.findMany({
      where: { projectId: { in: projectIds } },
      select: { id: true },
    })
  ).map((s) => s.id);
  const shots = (
    await db.videoShot.findMany({ where: { scriptId: { in: scripts } }, select: { id: true } })
  ).map((s) => s.id);
  await db.textOverlay.deleteMany({ where: { shotId: { in: shots } } }).catch(() => undefined);
  await db.videoShot.deleteMany({ where: { id: { in: shots } } });
  await db.videoScript.deleteMany({ where: { id: { in: scripts } } });
  await db.videoBrief.deleteMany({ where: { projectId: { in: projectIds } } });
  await db.videoProject.deleteMany({ where: { id: { in: projectIds } } });
  await db.approvalWorkflow.deleteMany({ where: { organisationId: { in: orgIds } } });
  await db.platformConnection.deleteMany({ where: { organisationId: { in: orgIds } } });
  await db.business.deleteMany({ where: { organisationId: { in: orgIds } } });
  await db.orgEntitlement.deleteMany({ where: { organisationId: { in: orgIds } } });
  await db.member.deleteMany({ where: { organizationId: { in: orgIds } } });
}
