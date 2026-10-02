import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import pino from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as decisionRoute from '../../src/app/api/studio/admin/safety-reviews/[id]/decision/route';
import * as listRoute from '../../src/app/api/studio/admin/safety-reviews/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import {
  evaluateContentSafety,
  type QualityCheck,
} from '../../src/lib/studio/pipeline/quality-checks';
import { openSafetyReview, SAFETY_REVIEW_ACTOR } from '../../src/lib/studio/pipeline/safety-review';
import { releaseSafetyHolds } from '../../src/lib/studio/ops/release-safety-holds';
import {
  NO_PROVIDER_RELEASE_NOTE,
  NO_PROVIDER_SCAN_DETAIL,
  releaseNoProviderSafetyReview,
} from '../../src/lib/studio/services/safety-reviews';
import { call, installApi, tenant } from '../helpers/api-harness';

// BACKLOG 13.17 — content-safety review queue: GET /admin/safety-reviews and POST
// /admin/safety-reviews/:id/decision (studio:admin:moderation + staff). ALLOW resumes the paused
// run, BLOCK fails it with the note; decided once; audited; the creator is notified.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('safety review API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const staffOrg = `api-sr-staff-${randomUUID()}`;
  const org = `api-sr-org-${randomUUID()}`;
  const tokens = {
    staff: tenant(staffOrg, ['studio:admin:moderation'], 'staff-1'),
    staffNoModeration: tenant(staffOrg, ['studio:admin:providers']),
    customer: tenant(org, ['studio:admin:moderation']),
  };
  let api: ReturnType<typeof installApi>;

  beforeEach(() => {
    api = installApi(db, tokens);
    vi.stubEnv('STUDIO_PLATFORM_ORG_IDS', staffOrg);
  });

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    setApiDeps(undefined);
    const projects = await db.videoProject.findMany({ where: { organisationId: org } });
    const ids = projects.map((p) => p.id);
    await db.safetyReview.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoShot.deleteMany({ where: { script: { projectId: { in: ids } } } });
    await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoScript.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.notification.deleteMany({ where: { organisationId: { in: [org, staffOrg] } } });
    await db.$disconnect();
  });

  const host = () => ({
    db,
    logger: pino({ level: 'silent' }),
    audit: api.deps.audit,
    now: Date.now,
  });

  const cleanChecks = (): QualityCheck[] => [
    { code: 'duration_match', status: 'passed', severity: 'error', detail: 'ok' },
  ];

  /** 20.19's check when no content-safety provider existed (review-level, so the run paused). */
  const noProviderFlag = (): QualityCheck => ({
    code: 'content_safety',
    status: 'failed',
    severity: 'error',
    detail: NO_PROVIDER_SCAN_DETAIL,
    detailKey: 'safetyScanUnavailable',
    detailParams: { reason: 'no content-safety provider available' },
  });

  /** A run paused by a review-level content flag on one render (as run-quality-gate leaves it). */
  async function pausedContentRun(extraFailure = false, noProvider = false) {
    const runId = randomUUID();
    const project = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: 'biz',
        createdByUserId: 'creator-1',
        name: 'How we slice a country loaf',
        state: 'QUALITY_CHECKING',
        sourceType: 'BRIEF',
        targetFormats: [],
        metadata: { runId, planTier: 'STANDARD' },
      },
    });
    const script = await db.videoScript.create({
      data: {
        projectId: project.id,
        targetPlatform: 'tiktok',
        targetAspectRatio: '9:16',
        targetDurationSec: 15,
        fullText: 'Slice it thick.',
        scriptModel: 'test',
      },
    });
    const flag = noProvider
      ? noProviderFlag()
      : evaluateContentSafety({
          scan: { framesAnalysed: 3, maxScores: { knife_in_hand: 0.86 }, flaggedFrames: [] },
        });
    const checks: QualityCheck[] = [
      ...cleanChecks(),
      flag,
      ...(extraFailure
        ? [
            {
              code: 'black_frames',
              status: 'failed',
              severity: 'error',
              detail: 'black 1–2s',
            } as const,
          ]
        : []),
    ];
    const render = await db.videoRender.create({
      data: {
        projectId: project.id,
        scriptId: script.id,
        targetPlatform: 'tiktok',
        aspectRatio: '9:16',
        resolution: '1080x1920',
        durationSec: 15,
        fps: 30,
        bitrateKbps: 4000,
        s3Bucket: 'renders',
        s3Key: `r/${randomUUID()}.mp4`,
        qualityCheckState: 'FAILED',
        qualityIssues: checks as unknown as Prisma.InputJsonValue,
      },
    });
    await db.$executeRaw`UPDATE "studio"."video_projects" SET "metadata" = jsonb_set("metadata", '{renders}', jsonb_build_object(${script.id}::text, ${render.id}::text)) WHERE "id" = ${project.id}`;
    const review = await openSafetyReview(host(), {
      organisationId: org,
      projectId: project.id,
      runId,
      planTier: 'STANDARD',
      kind: 'content',
      reason: `tiktok: ${flag.detail}`,
      details: [{ renderId: render.id, platform: 'tiktok', detail: flag.detail }],
      renderIds: [render.id],
    });
    return { project, render, review, runId };
  }

  it('is for staff with studio:admin:moderation only', async () => {
    expect((await call(listRoute.GET, { token: 'customer' })).status).toBe(403);
    expect((await call(listRoute.GET, { token: 'staffNoModeration' })).status).toBe(403);
    const decide = await call(decisionRoute.POST, {
      method: 'POST',
      token: 'customer',
      params: { id: 'x' },
      body: { decision: 'ALLOW', note: 'fine' },
    });
    expect(decide.status).toBe(403);
  });

  it('opening a review is idempotent per run and marks the project as waiting', async () => {
    const { project, review, runId } = await pausedContentRun();
    const again = await openSafetyReview(host(), {
      organisationId: org,
      projectId: project.id,
      runId,
      planTier: 'STANDARD',
      kind: 'content',
      reason: 'again',
      details: [],
    });
    expect(again.id).toBe(review.id);
    const meta = (await db.videoProject.findUniqueOrThrow({ where: { id: project.id } }))
      .metadata as { safetyReview?: { state: string } };
    expect(meta.safetyReview).toMatchObject({ id: review.id, state: 'PENDING', kind: 'content' });
    expect(api.audits.some((a) => a.action === 'studio.safety_review.open')).toBe(true);
    const staffNote = await db.notification.findFirst({
      where: { organisationId: staffOrg, kind: 'safety_review' },
    });
    expect(staffNote?.link).toBe('/admin?tab=safety');
  });

  it('lists pending reviews with a signed preview; validates the query', async () => {
    const { review } = await pausedContentRun();
    const res = await call(listRoute.GET, {
      token: 'staff',
      path: '/api/studio/admin/safety-reviews?state=PENDING',
    });
    expect(res.status).toBe(200);
    const item = (res.json.data as Array<Record<string, unknown>>).find((r) => r.id === review.id);
    expect(item).toMatchObject({
      organisationId: org,
      kind: 'content',
      state: 'PENDING',
      projectName: 'How we slice a country loaf',
      reason: expect.stringContaining('knife_in_hand'),
    });
    expect(typeof item?.previewUrl).toBe('string');
    expect(res.json.pendingCount).toEqual(expect.any(Number));
    const bad = await call(listRoute.GET, {
      token: 'staff',
      path: '/api/studio/admin/safety-reviews?state=MAYBE',
    });
    expect(bad.status).toBe(400);
  });

  it('ALLOW clears the flag and finishes the quality gate (READY_FOR_REVIEW)', async () => {
    const { project, render, review } = await pausedContentRun();
    const res = await call(decisionRoute.POST, {
      method: 'POST',
      token: 'staff',
      params: { id: review.id },
      body: { decision: 'ALLOW', note: 'Bread knife in a bakery context' },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      review: { id: review.id, state: 'ALLOWED' },
      project: { id: project.id, state: 'READY_FOR_REVIEW' },
    });
    const after = await db.videoRender.findUniqueOrThrow({ where: { id: render.id } });
    expect(after.qualityCheckState).toBe('PASSED');
    const safety = (after.qualityIssues as unknown as QualityCheck[]).find(
      (c) => c.code === 'content_safety',
    );
    expect(safety).toMatchObject({
      status: 'passed',
      detail: expect.stringContaining('Allowed by Trust & Safety'),
    });
    expect(api.audits.find((a) => a.action === 'studio.safety_review.decide')).toMatchObject({
      actorUserId: 'staff-1',
      metadata: expect.objectContaining({ decision: 'ALLOW', projectId: project.id }),
    });
    const told = await db.notification.findFirst({
      where: {
        organisationId: org,
        userId: 'creator-1',
        dedupeKey: `safety_review_decided:${review.id}`,
      },
    });
    expect(told?.title).toContain('passed its content-safety review');
    // Decided once.
    const again = await call(decisionRoute.POST, {
      method: 'POST',
      token: 'staff',
      params: { id: review.id },
      body: { decision: 'BLOCK', note: 'changed my mind' },
    });
    expect(again.status).toBe(409);
  });

  it('ALLOW with another failed check lands in QUALITY_FAILED (force-approvable)', async () => {
    const { project, review } = await pausedContentRun(true);
    const res = await call(decisionRoute.POST, {
      method: 'POST',
      token: 'staff',
      params: { id: review.id },
      body: { decision: 'ALLOW', note: 'Knife is fine' },
    });
    expect(res.json.project).toMatchObject({ state: 'QUALITY_FAILED' });
    const after = await db.videoProject.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.errorReason).toContain('black_frames');
  });

  it('BLOCK fails the project with the note', async () => {
    const { project, review } = await pausedContentRun();
    const res = await call(decisionRoute.POST, {
      method: 'POST',
      token: 'staff',
      params: { id: review.id },
      body: { decision: 'BLOCK', note: 'Weapon close-up is not allowed' },
    });
    expect(res.json).toMatchObject({ review: { state: 'BLOCKED' }, project: { state: 'FAILED' } });
    const after = await db.videoProject.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.errorReason).toBe(
      'content_safety_blocked_by_review: Weapon close-up is not allowed',
    );
  });

  it('validates the body and 404s an unknown review', async () => {
    const bad = await call(decisionRoute.POST, {
      method: 'POST',
      token: 'staff',
      params: { id: 'x' },
      body: { decision: 'MAYBE', note: 'x' },
    });
    expect(bad.status).toBe(400);
    const missing = await call(decisionRoute.POST, {
      method: 'POST',
      token: 'staff',
      params: { id: 'does-not-exist' },
      body: { decision: 'ALLOW', note: 'fine' },
    });
    expect(missing.status).toBe(404);
  });

  describe('20.21: releasing no-provider holds (scripts/ops/release-safety-holds.ts)', () => {
    const releaseDeps = () => ({ ...host(), afterReady: vi.fn(async () => undefined) });

    it('dry run lists only the no-provider reviews and changes nothing', async () => {
      const held = await pausedContentRun(false, true);
      const flagged = await pausedContentRun();
      const report = await releaseSafetyHolds(releaseDeps(), {
        dryRun: true,
        limit: 100,
        organisationId: org,
      });
      expect(report.releasable).toContain(held.review.id);
      expect(report.releasable).not.toContain(flagged.review.id);
      expect(report.released).toEqual([]);
      expect(
        (await db.safetyReview.findUniqueOrThrow({ where: { id: held.review.id } })).state,
      ).toBe('PENDING');
    });

    it('releases them: not scanned → READY_FOR_REVIEW; real flags stay for staff', async () => {
      const held = await pausedContentRun(false, true);
      const flagged = await pausedContentRun();
      const deps = releaseDeps();
      const report = await releaseSafetyHolds(deps, {
        dryRun: false,
        limit: 100,
        organisationId: org,
      });
      expect(report.released).toContain(held.review.id);
      expect(report.released).not.toContain(flagged.review.id);
      expect(report.skipped).toEqual([]);

      const review = await db.safetyReview.findUniqueOrThrow({ where: { id: held.review.id } });
      expect(review).toMatchObject({
        state: 'ALLOWED',
        decidedByUserId: SAFETY_REVIEW_ACTOR,
        decisionNote: NO_PROVIDER_RELEASE_NOTE,
      });
      const project = await db.videoProject.findUniqueOrThrow({ where: { id: held.project.id } });
      expect(project.state).toBe('READY_FOR_REVIEW');
      expect(project.metadata).toMatchObject({
        safetyReview: { state: 'ALLOWED' },
        contentSafety: { state: 'skipped', reason: 'no_provider' },
      });
      const render = await db.videoRender.findUniqueOrThrow({ where: { id: held.render.id } });
      expect(render.qualityCheckState).toBe('PASSED');
      expect(render.qualityIssues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'content_safety',
            status: 'not_run',
            detailKey: 'safetyNotScanned',
          }),
        ]),
      );
      expect(deps.afterReady).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: held.project.id, runId: held.runId }),
      );
      expect(api.audits.at(-1)).toMatchObject({
        actorUserId: SAFETY_REVIEW_ACTOR,
        action: 'studio.safety_review.release',
        resource: { type: 'safety_review', id: held.review.id },
      });
      // The creator is not told about a safety review result (there was no review).
      expect(
        await db.notification.count({
          where: { organisationId: org, dedupeKey: `safety_review_decided:${held.review.id}` },
        }),
      ).toBe(0);

      // The real flag is untouched.
      expect(
        (await db.safetyReview.findUniqueOrThrow({ where: { id: flagged.review.id } })).state,
      ).toBe('PENDING');
      // Re-running is safe.
      expect(await releaseNoProviderSafetyReview(host(), held.review.id)).toBe('not_pending');
      expect(await releaseNoProviderSafetyReview(host(), flagged.review.id)).toBe(
        'not_no_provider',
      );
    });

    it('a no-provider hold with another failed check lands in QUALITY_FAILED', async () => {
      const held = await pausedContentRun(true, true);
      expect(await releaseNoProviderSafetyReview(host(), held.review.id)).toBe('released');
      const project = await db.videoProject.findUniqueOrThrow({ where: { id: held.project.id } });
      expect(project.state).toBe('QUALITY_FAILED');
      expect(project.errorReason).toContain('black_frames');
      expect(project.errorReason).not.toContain('content_safety');
    });
  });
});
