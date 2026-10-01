import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import {
  ALWAYS_HASHTAG_MAX_CHARS,
  BUSINESS_HASHTAG_MAX_CHARS,
  deriveBusinessHashtag,
  MAX_ALWAYS_HASHTAGS,
  validateBusinessHashtag,
  validateOwnerHashtag,
} from '../hashtags/business-hashtag';
import { MIN_HASHTAGS, type HashtagPolicy } from '../hashtags/policy';

// 20.13 — Business settings → Hashtags: the business hashtag (default derived from the business
// name) and the owner's "always include" hashtags, per business (organisation-scoped like every
// Studio table). The business name comes from studio.businesses (standalone mode); in core mode
// Studio has no business names yet (business-directory.ts), so the business hashtag is whatever
// the owner sets, and none until then.
//   GET /api/studio/businesses/:id/hashtags → { hashtags: BusinessHashtags }
//   PUT /api/studio/businesses/:id/hashtags { primaryHashtag: string | null, alwaysHashtags: [] }

type Db = Pick<PrismaClient, 'businessHashtagSettings' | 'business'>;
type Scope = { organisationId: string; businessId: string };

export const businessHashtagsInput = z
  .object({
    /** null (or omitted) = use the default derived from the business name. */
    primaryHashtag: z.string().max(200).nullable().optional(),
    alwaysHashtags: z.array(z.string().max(200)).max(MAX_ALWAYS_HASHTAGS).default([]),
  })
  .strict();

export interface BusinessHashtags {
  /** The hashtag posts carry (no "#"), or null when there is none yet. */
  primaryHashtag: string | null;
  /** The default from the business name (no "#"), or null. */
  derivedHashtag: string | null;
  /** True when the owner set primaryHashtag (otherwise it is the derived default). */
  custom: boolean;
  alwaysHashtags: string[];
  minHashtags: number;
  maxChars: number;
  maxAlways: number;
  updatedAt: string | null;
}

async function businessName(db: Pick<PrismaClient, 'business'>, scope: Scope) {
  const row = await db.business
    .findFirst({
      where: { id: scope.businessId, organisationId: scope.organisationId, deletedAt: null },
      select: { name: true },
    })
    // Defensive: a database without studio.businesses rows for this id (core mode) has no name.
    .catch(() => null);
  return row?.name ?? null;
}

export async function getBusinessHashtags(db: Db, scope: Scope): Promise<BusinessHashtags> {
  const [row, name] = await Promise.all([
    db.businessHashtagSettings.findUnique({ where: { organisationId_businessId: scope } }),
    businessName(db, scope),
  ]);
  const derivedHashtag = deriveBusinessHashtag(name);
  return {
    primaryHashtag: row?.primaryHashtag ?? derivedHashtag,
    derivedHashtag,
    custom: Boolean(row?.primaryHashtag),
    alwaysHashtags: row?.alwaysHashtags ?? [],
    minHashtags: MIN_HASHTAGS,
    maxChars: BUSINESS_HASHTAG_MAX_CHARS,
    maxAlways: MAX_ALWAYS_HASHTAGS,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

/** The business + always hashtags every post of the business carries. */
export async function loadHashtagPolicy(db: Db, scope: Scope): Promise<HashtagPolicy> {
  const settings = await getBusinessHashtags(db, scope);
  return { business: settings.primaryHashtag, always: settings.alwaysHashtags };
}

export async function putBusinessHashtags(
  db: Db,
  scope: Scope,
  userId: string,
  input: z.infer<typeof businessHashtagsInput>,
): Promise<BusinessHashtags> {
  const primary =
    input.primaryHashtag === null ||
    input.primaryHashtag === undefined ||
    !input.primaryHashtag.trim()
      ? null
      : validateBusinessHashtag(input.primaryHashtag);
  const seen = new Set(primary ? [primary.toLowerCase()] : []);
  const always: string[] = [];
  for (const raw of input.alwaysHashtags) {
    const tag = validateOwnerHashtag(raw, ALWAYS_HASHTAG_MAX_CHARS, 'alwaysHashtags');
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    always.push(tag);
  }
  if (!primary && !deriveBusinessHashtag(await businessName(db, scope)) && always.length === 0)
    // Nothing to save would make every post rely on AI hashtags alone; a business hashtag is the
    // operator's rule, so the owner is asked for one.
    throw new ValidationError('Set a business hashtag: the business name gives no default', {
      field: 'primaryHashtag',
      problem: 'required',
    });
  await db.businessHashtagSettings.upsert({
    where: { organisationId_businessId: scope },
    create: { ...scope, primaryHashtag: primary, alwaysHashtags: always, updatedByUserId: userId },
    update: { primaryHashtag: primary, alwaysHashtags: always, updatedByUserId: userId },
  });
  return getBusinessHashtags(db, scope);
}
