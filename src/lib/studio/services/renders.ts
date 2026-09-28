import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, ForbiddenError, NotFoundError } from '../../errors';
import type { TenantContext } from '../../tenant';
import type { QualityCheck } from '../pipeline/quality-checks';
import { currentRunId, transitionProject } from '../pipeline/project-state';
import type { AssetStorage } from '../storage';

// Renders (spec 8.4) and force-approve (spec 13.5).

export const PREVIEW_URL_TTL_SEC = 60 * 60;
export const DOWNLOAD_URL_TTL_SEC = 15 * 60;

export const forceApproveInput = z.object({ note: z.string().trim().min(1).max(2_000) });

export async function findRender(db: PrismaClient, organisationId: string, id: string) {
  const render = await db.videoRender.findFirst({
    where: { id, project: { organisationId, deletedAt: null } },
    include: {
      project: { select: { id: true, organisationId: true, state: true, metadata: true } },
    },
  });
  if (!render) throw new NotFoundError('Render not found');
  return render;
}

export async function listRenders(db: PrismaClient, organisationId: string, projectId: string) {
  const project = await db.videoProject.findFirst({
    where: { id: projectId, organisationId, deletedAt: null },
    select: { id: true },
  });
  if (!project) throw new NotFoundError('Project not found');
  return db.videoRender.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
}

export async function signedRenderUrl(
  deps: { db: PrismaClient; storage: AssetStorage },
  organisationId: string,
  id: string,
  ttlSec: number,
) {
  const render = await findRender(deps.db, organisationId, id);
  return {
    url: await deps.storage.signedUrl(render.s3Bucket, render.s3Key, ttlSec),
    expiresInSec: ttlSec,
  };
}

/**
 * Override a failed quality gate for one render. Content-safety BLOCK results can only be cleared
 * by PostMind staff moderation, never by the customer. When every render of the current run is
 * PASSED or FORCE_APPROVED, the project returns to READY_FOR_REVIEW.
 */
export async function forceApproveRender(
  db: PrismaClient,
  tenant: TenantContext,
  id: string,
  note: string,
) {
  const render = await findRender(db, tenant.organisationId, id);
  if (render.qualityCheckState !== 'FAILED') {
    throw new ConflictError(
      `Render quality state is ${render.qualityCheckState}; only FAILED renders can be force-approved`,
    );
  }
  const checks = (render.qualityIssues as unknown as QualityCheck[] | null) ?? [];
  if (checks.some((c) => c.status === 'failed' && c.severity === 'block')) {
    throw new ForbiddenError('Content-safety blocks require PostMind staff moderation (spec 13.5)');
  }
  await db.videoRender.update({
    where: { id },
    data: {
      qualityCheckState: 'FORCE_APPROVED',
      qualityIssues: [
        ...checks,
        {
          code: 'force_approved',
          status: 'passed',
          severity: 'info',
          detail: `by ${tenant.userId}: ${note}`,
          // 17.9: shown in the reader's language; the reviewer's note stays as written.
          detailKey: 'forceApproved',
          detailParams: { note },
          // 15.D5: structured copy for the Admin Centre force-approve review.
          userId: tenant.userId,
          note,
          at: new Date().toISOString(),
        },
      ] as unknown as Prisma.InputJsonValue,
    },
  });

  const runId = currentRunId(render.project);
  const renderIds = Object.values(
    ((render.project.metadata as Record<string, unknown> | null)?.renders as Record<
      string,
      string
    >) ?? {},
  );
  const runRenders = await db.videoRender.findMany({
    where: { id: { in: renderIds } },
    select: { qualityCheckState: true },
  });
  const allClear =
    runRenders.length > 0 &&
    runRenders.every(
      (r) => r.qualityCheckState === 'PASSED' || r.qualityCheckState === 'FORCE_APPROVED',
    );
  let projectReady = false;
  if (allClear && runId) {
    projectReady = await transitionProject(db, {
      projectId: render.projectId,
      runId,
      from: ['QUALITY_FAILED'],
      to: 'READY_FOR_REVIEW',
      data: { errorReason: null },
    });
  }
  return { renderId: id, projectReadyForReview: projectReady };
}
