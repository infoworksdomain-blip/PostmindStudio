import type { PrismaClient } from '@prisma/client';
import { ValidationError } from '../../errors';
import {
  checkRealPersonRequest,
  UGC_REAL_PERSON_MESSAGE,
  UGC_REAL_PERSON_REASON,
} from './real-person';
import { isUgcLanguage, UGC_MAX_DURATION_SEC, type UgcInput } from './style';

// BACKLOG 21.4 — the rules a UGC actor project must meet, checked by the projects service when it
// is created, edited or generated. There is no tier gate: every active subscriber may make UGC
// videos (operator decision 2026-10-04); a UGC video uses more of the allowance (ugc/allowance.ts).

export interface UgcProjectShape {
  sourceType: string;
  formats: ReadonlyArray<{ durationSec?: number; duration?: number }>;
  language?: string | null;
  languages?: readonly string[] | null;
}

/** 422 with a reason the UI translates, for a brief that asks for a real person. */
export function assertNoRealPerson(...texts: Array<string | null | undefined>): void {
  const check = checkRealPersonRequest(...texts);
  if (check.refused)
    throw new ValidationError(UGC_REAL_PERSON_MESSAGE, { reason: UGC_REAL_PERSON_REASON });
}

export function assertUgcShape(project: UgcProjectShape): void {
  if (project.sourceType !== 'BRIEF')
    throw new ValidationError('UGC actor videos are made from a brief', { field: 'ugc' });
  const longest = Math.max(0, ...project.formats.map((f) => f.durationSec ?? f.duration ?? 0));
  if (longest > UGC_MAX_DURATION_SEC)
    throw new ValidationError(
      `UGC actor videos are short-form: at most ${UGC_MAX_DURATION_SEC} seconds`,
      { field: 'targetFormats', maxSec: UGC_MAX_DURATION_SEC },
    );
  const languages = [project.language ?? 'en-GB', ...(project.languages ?? [])];
  if (!languages.every(isUgcLanguage))
    throw new ValidationError('UGC actors speak English only for now', { field: 'language' });
}

/** The chosen product image must be in the business's image library. */
export async function assertUgcProductImage(
  db: Pick<PrismaClient, 'imageLibraryItem'>,
  scope: { organisationId: string; businessId: string },
  input: UgcInput,
): Promise<void> {
  const imageId = input.product?.imageId;
  if (!imageId) return;
  const found = await db.imageLibraryItem.findFirst({
    where: { id: imageId, organisationId: scope.organisationId, businessId: scope.businessId },
    select: { id: true },
  });
  if (!found)
    throw new ValidationError('ugc.product.imageId is not in this business’s image library', {
      field: 'ugc.product.imageId',
    });
}
