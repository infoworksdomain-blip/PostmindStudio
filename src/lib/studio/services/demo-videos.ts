import type { Prisma, PrismaClient, VideoUpload } from '@prisma/client';
import { z } from 'zod';
import { NoDemoVideoError } from '../../errors';
import { DEMO_MIN_SEC } from '../formats/hook-demo';
import { presentUpload } from './uploads';

// BACKLOG 22.1 — the business's demo-video bank: product or app demo videos the business uploaded
// (POST /uploads { kind: demo_video, businessId } → PUT → /uploads/:id/complete; the existing
// upload path, storage and checks). Hook + demo videos pick one (or the newest), and the same
// demo can serve any number of videos. Fastlane refuses to build its hook + demo format when the
// workspace has no demo video (`no_demo_video`); Studio answers the same code.

type Db = Pick<PrismaClient, 'videoUpload'>;

export const NO_DEMO_VIDEO_MESSAGE =
  'Upload a demo video of your product or app first: a hook + demo video shows your own demo after the hook';

export const listDemoVideosQuery = z.object({
  businessId: z.string().trim().min(1).max(128),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** The business's READY demo videos, newest first (GET /api/studio/uploads/demo-videos). */
export async function listDemoVideos(
  db: Db,
  organisationId: string,
  query: z.infer<typeof listDemoVideosQuery>,
) {
  const rows = await db.videoUpload.findMany({
    where: { organisationId, businessId: query.businessId, kind: 'DEMO_VIDEO', state: 'READY' },
    orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
    take: query.limit,
  });
  return { data: rows.map(presentUpload) };
}

/**
 * The demo video a new hook + demo project uses: the chosen one (a READY demo video of this
 * business) or, when none was chosen, the business's newest. NoDemoVideoError (no_demo_video)
 * when there is none, the choice is not this business's ready demo, or it is too short.
 */
export async function resolveDemoUpload(
  db: Db | Prisma.TransactionClient,
  input: { organisationId: string; businessId: string; demoUploadId?: string },
): Promise<VideoUpload> {
  const where = {
    organisationId: input.organisationId,
    businessId: input.businessId,
    kind: 'DEMO_VIDEO' as const,
    state: 'READY' as const,
  };
  const upload = input.demoUploadId
    ? await db.videoUpload.findFirst({ where: { ...where, id: input.demoUploadId } })
    : await db.videoUpload.findFirst({
        where,
        orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      });
  if (!upload)
    throw new NoDemoVideoError(NO_DEMO_VIDEO_MESSAGE, {
      reason: input.demoUploadId ? 'demo_not_found' : 'no_demo_video',
    });
  if (!upload.durationSec || upload.durationSec < DEMO_MIN_SEC)
    throw new NoDemoVideoError(`The demo video must be at least ${DEMO_MIN_SEC} seconds long`, {
      reason: 'demo_too_short',
    });
  return upload;
}
