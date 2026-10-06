import { randomInt } from 'node:crypto';
import type { Creator, CreatorPortrait, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  ConflictError,
  NotFoundError,
  ProviderError,
  RateLimitError,
  ValidationError,
} from '../../errors';
import type { TenantContext } from '../../tenant';
import type { ProviderRunDeps } from '../pipeline/provider-run';
import type { AssetStorage } from '../storage';
import { generateCreatorPortrait } from '../ugc/creator-portrait';
import { portraitUnavailableReason } from '../ugc/portrait';
import {
  creatorDescription,
  MAX_UGC_SEED,
  UGC_AGE_RANGES,
  UGC_GENDERS,
  UGC_SETTINGS,
  type UgcCreatorChoice,
} from '../ugc/style';
import { UGC_REAL_PERSON_MESSAGE, UGC_REAL_PERSON_REASON } from '../ugc/real-person';
import { assertNoRealPerson } from '../ugc/validate';
import { toPlanTier } from './catalog';

// BACKLOG 22.3 — reusable AI creators (operator 2026-10-05: "replicate how Fastlane makes
// videos"; Fastlane lets a workspace create AI influencers once and reuse them). A business keeps
// up to MAX_CREATORS_PER_BUSINESS creators: a name, presets (gender, age range, setting), look
// notes, a voice-tone note and ONE current portrait. The portrait is generated through the same
// route, budgets, caps and kill switch as a project's one-off actor portrait (21.4a) and
// "Regenerate" can add instructions; or it is an uploaded photo, only with the uploader's explicit
// attestation that they have the person's consent and rights (stored with who and when). Every
// owner text is real-person checked first. RETIRED creators stay for the projects that used them
// and are no longer offered. Everything is scoped by organisation AND business.

export const MAX_CREATORS_PER_BUSINESS = 20;
/** Generated portraits (create + regenerate) per organisation per 24 hours. */
export const MAX_CREATOR_PORTRAITS_PER_ORG_PER_DAY = 30;
const DAY_MS = 86_400_000;
export const PORTRAIT_URL_TTL_SEC = 60 * 60;

const name = z.string().trim().min(1).max(60);
const appearance = z.string().trim().max(300);
const voiceTone = z.string().trim().max(120);

export const createCreatorInput = z
  .object({
    name,
    gender: z.enum(UGC_GENDERS),
    ageRange: z.enum(UGC_AGE_RANGES),
    setting: z.enum(UGC_SETTINGS),
    appearance: appearance.optional(),
    voiceTone: voiceTone.optional(),
  })
  .strict();
export type CreateCreatorInput = z.infer<typeof createCreatorInput>;

export const updateCreatorInput = z
  .object({
    name: name.optional(),
    voiceTone: voiceTone.nullable().optional(),
    /** The business's default creator for month-plan UGC items (true only; unset by another). */
    isDefault: z.literal(true).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const regenerateCreatorInput = z
  .object({ instructions: z.string().trim().max(300).optional() })
  .strict();

export const listCreatorsQuery = z.object({
  includeRetired: z.enum(['true', 'false']).optional(),
});

export interface CreatorDeps {
  db: PrismaClient;
  storage: AssetStorage;
  /** The assets bucket (never the image library). */
  bucket: string;
  providers: ProviderRunDeps;
  now: () => number;
}

/**
 * A creator's texts describe the person themself, so "looks like <Name>" needs no "a person who"
 * before it (ugc/real-person.ts asks for one so a brief's "make it look like New York" passes).
 */
const NAMED_LIKENESS = new RegExp(
  String.raw`\b(?:looks?|looking|resembl\w*)\s+(?:just\s+|exactly\s+)?(?:like\s+)?(?:a\s+young\s+)?[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+)+`,
  'u',
);

/** The UGC real-person refusal (ugc/validate.ts), plus a named likeness in a creator's texts. */
export function assertCreatorTexts(...texts: Array<string | null | undefined>): void {
  assertNoRealPerson(...texts);
  if (texts.some((t) => t && NAMED_LIKENESS.test(t)))
    throw new ValidationError(UGC_REAL_PERSON_MESSAGE, { reason: UGC_REAL_PERSON_REASON });
}

/** The route's deps (ApiDeps): generation goes through the library's provider wiring. */
export function creatorDepsFrom(api: {
  db: PrismaClient;
  storage: AssetStorage;
  library: { bucket: string; providers: ProviderRunDeps };
  now: () => number;
}): CreatorDeps {
  return {
    db: api.db,
    storage: api.storage,
    bucket: api.library.bucket,
    providers: api.library.providers,
    now: api.now,
  };
}

type Scope = { organisationId: string; businessId: string };
type CreatorTenant = Pick<TenantContext, 'organisationId' | 'userId' | 'organisation'>;

/** Public shape: a short-lived portrait URL, never storage coordinates or a cost. */
export async function presentCreator(
  storage: AssetStorage,
  row: Creator,
  portrait: CreatorPortrait | null,
) {
  return {
    id: row.id,
    businessId: row.businessId,
    name: row.name,
    gender: row.gender,
    ageRange: row.ageRange,
    setting: row.setting,
    appearance: row.appearance,
    voiceTone: row.voiceTone,
    status: row.status,
    isDefault: row.isDefault,
    useCount: row.useCount,
    lastUsedAt: row.lastUsedAt,
    portraitError: row.portraitError,
    portraitSource: portrait?.source ?? null,
    portraitUrl: portrait
      ? await storage.signedUrl(portrait.s3Bucket, portrait.s3Key, PORTRAIT_URL_TTL_SEC)
      : null,
    createdAt: row.createdAt,
    retiredAt: row.retiredAt,
  };
}

export type PresentedCreator = Awaited<ReturnType<typeof presentCreator>>;

async function portraitOf(db: PrismaClient, row: Creator): Promise<CreatorPortrait | null> {
  if (!row.portraitId) return null;
  return db.creatorPortrait.findFirst({
    where: { id: row.portraitId, organisationId: row.organisationId, creatorId: row.id },
  });
}

export async function present(deps: Pick<CreatorDeps, 'db' | 'storage'>, row: Creator) {
  return presentCreator(deps.storage, row, await portraitOf(deps.db, row));
}

/** READY first, most used first (the Create picker's default is the first READY one). */
export async function listCreators(
  deps: Pick<CreatorDeps, 'db' | 'storage'>,
  scope: Scope,
  options: { includeRetired?: boolean } = {},
) {
  const rows = await deps.db.creator.findMany({
    where: { ...scope, ...(!options.includeRetired && { status: { not: 'RETIRED' } }) },
    orderBy: [{ useCount: 'desc' }, { createdAt: 'desc' }],
  });
  const ids = rows.map((r) => r.portraitId).filter((id): id is string => Boolean(id));
  const portraits = ids.length
    ? await deps.db.creatorPortrait.findMany({
        where: { id: { in: ids }, organisationId: scope.organisationId },
      })
    : [];
  const byId = new Map(portraits.map((p) => [p.id, p]));
  const order = { READY: 0, DRAFT: 1, RETIRED: 2 } as const;
  const sorted = [...rows].sort((a, b) => order[a.status] - order[b.status]);
  return Promise.all(
    sorted.map((r) => presentCreator(deps.storage, r, byId.get(r.portraitId ?? '') ?? null)),
  );
}

export async function findCreator(db: PrismaClient, scope: Scope, id: string): Promise<Creator> {
  const row = await db.creator.findFirst({ where: { id, ...scope } });
  if (!row) throw new NotFoundError('Creator not found');
  return row;
}

export async function assertCreatorRoom(db: PrismaClient, scope: Scope): Promise<void> {
  const live = await db.creator.count({ where: { ...scope, status: { not: 'RETIRED' } } });
  if (live >= MAX_CREATORS_PER_BUSINESS)
    throw new ConflictError(
      `A business can have at most ${MAX_CREATORS_PER_BUSINESS} creators; retire one first`,
      { reason: 'creator_limit', max: MAX_CREATORS_PER_BUSINESS },
    );
}

async function assertDailyPortraitCap(db: PrismaClient, organisationId: string, now: number) {
  const today = await db.creatorPortrait.count({
    where: { organisationId, source: 'GENERATED', createdAt: { gte: new Date(now - DAY_MS) } },
  });
  if (today >= MAX_CREATOR_PORTRAITS_PER_ORG_PER_DAY)
    throw new RateLimitError(
      `At most ${MAX_CREATOR_PORTRAITS_PER_ORG_PER_DAY} creator portraits per 24 hours`,
      3_600,
      { reason: 'creator_portrait_daily_cap' },
    );
}

export interface CreatorResult {
  creator: Creator;
  /** Why no portrait was made this time (the creator stays DRAFT; "Regenerate" tries again). */
  portraitError: string | null;
}

/** POST /businesses/:id/creators — a new creator and its first generated portrait. */
export async function createCreator(
  deps: CreatorDeps,
  tenant: CreatorTenant,
  businessId: string,
  input: CreateCreatorInput,
): Promise<CreatorResult> {
  const scope = { organisationId: tenant.organisationId, businessId };
  assertCreatorTexts(input.name, input.appearance, input.voiceTone);
  await assertCreatorRoom(deps.db, scope);
  await assertDailyPortraitCap(deps.db, tenant.organisationId, deps.now());
  const creator = await deps.db.creator.create({
    data: {
      ...scope,
      name: input.name,
      gender: input.gender,
      ageRange: input.ageRange,
      setting: input.setting,
      appearance: input.appearance || null,
      voiceTone: input.voiceTone || null,
      description: creatorDescription({
        gender: input.gender,
        ageRange: input.ageRange,
        appearance: input.appearance ?? null,
        seed: randomInt(0, MAX_UGC_SEED),
      }),
      createdByUserId: tenant.userId,
    },
  });
  return makePortrait(deps, tenant, creator, null);
}

/** POST /businesses/:id/creators/:creatorId/regenerate — a new portrait (optional instructions). */
export async function regenerateCreator(
  deps: CreatorDeps,
  tenant: CreatorTenant,
  businessId: string,
  id: string,
  input: z.infer<typeof regenerateCreatorInput>,
): Promise<CreatorResult> {
  const scope = { organisationId: tenant.organisationId, businessId };
  const creator = await findCreator(deps.db, scope, id);
  if (creator.status === 'RETIRED') throw new ConflictError('This creator is retired');
  assertCreatorTexts(input.instructions);
  await assertDailyPortraitCap(deps.db, tenant.organisationId, deps.now());
  return makePortrait(deps, tenant, creator, input.instructions || null);
}

async function makePortrait(
  deps: CreatorDeps,
  tenant: CreatorTenant,
  creator: Creator,
  instructions: string | null,
): Promise<CreatorResult> {
  const where = { id: creator.id, organisationId: creator.organisationId };
  let generated: Awaited<ReturnType<typeof generateCreatorPortrait>>;
  try {
    generated = await generateCreatorPortrait(
      { providers: deps.providers, storage: deps.storage, bucket: deps.bucket },
      {
        organisationId: creator.organisationId,
        creatorId: creator.id,
        planTier: toPlanTier(tenant.organisation.planTier),
        description: creator.description,
        setting: creator.setting as UgcCreatorChoice['setting'],
        instructions,
      },
    );
  } catch (err) {
    const reason =
      portraitUnavailableReason(err) ??
      (err instanceof ProviderError && err.errorClass === 'unsupported_image_type'
        ? err.errorClass
        : 'failed');
    const updated = await deps.db.creator.update({ where, data: { portraitError: reason } });
    // A refusal or an unavailable provider is an answer (DRAFT, "Regenerate" later); anything
    // else (a kill switch, a budget cap, a transient failure) is the request's error.
    if (reason === 'failed') throw err;
    return { creator: updated, portraitError: reason };
  }
  const updated = await deps.db.$transaction(async (tx) => {
    const portrait = await tx.creatorPortrait.create({
      data: {
        organisationId: creator.organisationId,
        businessId: creator.businessId,
        creatorId: creator.id,
        source: 'GENERATED',
        s3Bucket: generated.s3Bucket,
        s3Key: generated.s3Key,
        contentType: generated.contentType,
        prompt: generated.prompt,
        instructions,
        providerId: generated.providerId,
        providerJobId: generated.providerJobId,
        costPence: generated.costPence,
        createdByUserId: tenant.userId,
      },
    });
    return tx.creator.update({
      where,
      data: {
        portraitId: portrait.id,
        portraitError: null,
        ...(creator.status === 'DRAFT' && { status: 'READY' }),
      },
    });
  });
  return { creator: updated, portraitError: null };
}

/** PATCH /businesses/:id/creators/:creatorId — rename, voice note, make the plan default. */
export async function updateCreator(
  db: PrismaClient,
  scope: Scope,
  id: string,
  input: z.infer<typeof updateCreatorInput>,
): Promise<Creator> {
  const creator = await findCreator(db, scope, id);
  if (creator.status === 'RETIRED') throw new ConflictError('This creator is retired');
  assertCreatorTexts(input.name, input.voiceTone);
  if (input.isDefault && creator.status !== 'READY')
    throw new ConflictError('Only a ready creator can be the default');
  return db.$transaction(async (tx) => {
    if (input.isDefault)
      await tx.creator.updateMany({
        where: { ...scope, isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
    return tx.creator.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.voiceTone !== undefined && { voiceTone: input.voiceTone || null }),
        ...(input.isDefault && { isDefault: true }),
      },
    });
  });
}

/**
 * POST /businesses/:id/creators/:creatorId/retire — no longer offered for new videos; projects
 * that already use the creator keep its portrait.
 */
export async function retireCreator(
  db: PrismaClient,
  tenant: Pick<TenantContext, 'organisationId' | 'userId'>,
  businessId: string,
  id: string,
  now: number,
): Promise<Creator> {
  const scope = { organisationId: tenant.organisationId, businessId };
  const creator = await findCreator(db, scope, id);
  if (creator.status === 'RETIRED') return creator;
  const retired = await db.creator.updateMany({
    where: { id, ...scope, status: creator.status },
    data: {
      status: 'RETIRED',
      isDefault: false,
      retiredAt: new Date(now),
      retiredByUserId: tenant.userId,
    },
  });
  if (retired.count === 0) throw new ConflictError('Creator changed concurrently; reload');
  return findCreator(db, scope, id);
}

/** A project's chosen creator: READY, with a portrait, of the project's business. */
export async function resolveProjectCreator(
  db: Pick<PrismaClient, 'creator'>,
  scope: Scope,
  creatorId: string,
): Promise<UgcCreatorChoice> {
  const row = await db.creator.findFirst({ where: { id: creatorId, ...scope } });
  if (!row || row.status !== 'READY' || !row.portraitId)
    throw new ValidationError('ugc.creatorId is not a ready creator of this business', {
      field: 'ugc.creatorId',
    });
  return {
    id: row.id,
    portraitId: row.portraitId,
    description: row.description,
    voiceTone: row.voiceTone,
    gender: row.gender as UgcCreatorChoice['gender'],
    ageRange: row.ageRange as UgcCreatorChoice['ageRange'],
    setting: row.setting as UgcCreatorChoice['setting'],
  };
}

/** Counted when a project is created with the creator (the picker's "most used"). */
export function recordCreatorUse(
  tx: Pick<Prisma.TransactionClient, 'creator'>,
  scope: Scope,
  creatorId: string,
  now: number,
) {
  return tx.creator.updateMany({
    where: { id: creatorId, ...scope },
    data: { useCount: { increment: 1 }, lastUsedAt: new Date(now) },
  });
}

/**
 * The creator a month plan's UGC items use: the business's default, else its most used READY
 * creator, else none (each item gets a one-off actor, the 21.4 behaviour).
 */
export async function defaultCreatorId(
  db: Pick<PrismaClient, 'creator'>,
  scope: Scope,
): Promise<string | null> {
  const row = await db.creator.findFirst({
    where: { ...scope, status: 'READY', portraitId: { not: null } },
    orderBy: [{ isDefault: 'desc' }, { useCount: 'desc' }, { createdAt: 'asc' }],
    select: { id: true },
  });
  return row?.id ?? null;
}
