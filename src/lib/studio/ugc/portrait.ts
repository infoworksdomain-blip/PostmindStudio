import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { NotFoundError, RateDeferredError } from '../../errors';
import { avatarUnavailableReason } from '../pipeline/avatar-fallback';
import type { PipelineDeps } from '../pipeline/deps';
import { copyUrlToStorage } from '../pipeline/persist';
import { runProvider, type ProviderRunResult } from '../pipeline/provider-run';
import { isGenerationRefusal } from '../pipeline/still-image';
import type { PlanTier } from '../providers/router';
import { providerOutputKey } from '../storage';
import { PORTRAIT_ASPECT } from './prompt';
import { checkRealPersonRequest } from './real-person';
import { actorDescription, SETTING_TEXT, type UgcStyle } from './style';

// BACKLOG 21.4a — ONE actor per UGC video. Production 2026-10-04 (project cmuuazud…): each actor
// clip was generated separately from the same text description and seed, and clip 3 showed a
// different woman. Veo 3.1 documents subject reference images ("Provide images of a person,
// character, or product to preserve the subject's appearance in the output video", up to 3,
// https://ai.google.dev/gemini-api/docs/veo, read 2026-10-04), so each UGC project gets ONE
// generated actor portrait, made once from the stored actor description (presets + seed, never
// owner free text, never a real person) through Studio's own image generation (the IMAGE_STILL
// route: OpenAI gpt-image-2, then fal / Ideogram; router, budgets, cost tracking and kill switch as
// for any still), stored as an IMAGE asset of the project and recorded at
// metadata.ugc.actorImage. Every actor clip of the project, and every regenerated clip, sends that
// same image (veo.ts: a subject reference; kling.ts: the first frame).
//
// Actor shots are generated in parallel (one generate-asset job each), so the portrait is made
// under a claim: the first shot claims it (compare-and-set on metadata.ugc.actorImage), the others
// see "generating" and are deferred (RateDeferredError: the job waits without using an attempt)
// until it is ready. A claim older than PORTRAIT_CLAIM_STALE_MS (a crashed worker) is taken over.
// When no portrait can be made (no image provider, account problem, refusal) the run records
// "unavailable" and its clips go on without one (the 21.4 behaviour: same description and seed); a
// later run tries again. A changed actor look (a new description) makes a new portrait.

/** The asset's metadata.role (it is not a shot's visual and never goes to the image library). */
export const ACTOR_PORTRAIT_ROLE = 'ugc_actor_portrait';
/** A claim older than this belongs to a worker that died: another shot may take it over. */
export const PORTRAIT_CLAIM_STALE_MS = 5 * 60_000;
/** How long a shot waits before looking again while another shot makes the portrait. */
export const PORTRAIT_WAIT_MS = 10_000;
/** RateDeferredError "provider" label for the wait (logs and the admin view). */
export const PORTRAIT_DEFER_ID = 'ugc-portrait';
export { PORTRAIT_ASPECT };
/** Veo fetches reference images as PNG or JPEG only (veo.ts fetchImage). */
const PORTRAIT_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg']);
const CAS_ATTEMPTS = 3;

/**
 * The portrait prompt: only the stored actor description (presets + seed) and setting, so no
 * owner text can name or describe a real person. Head and shoulders, facing the camera, nothing in
 * the hands (the product is its own reference image), no text.
 */
export function actorPortraitPrompt(style: UgcStyle): string {
  return [
    `Photorealistic vertical smartphone selfie photo of a fictional person who does not exist: ${actorDescription(style)}, in ${SETTING_TEXT[style.actor.setting]}.`,
    'Head and shoulders, facing the camera and looking into the lens with a relaxed, friendly expression; natural daylight; the whole face and hair clearly visible and in sharp focus.',
    // No "celebrity" here: the real-person check (real-person.ts) matches that word.
    'An everyday, ordinary-looking person; not anyone famous and not any real, identifiable person.',
    'Nothing in their hands. No text, captions, logos or watermarks.',
  ].join(' ');
}

const actorImageSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('generating'),
    description: z.string(),
    claimedAt: z.number(),
    claimId: z.string(),
  }),
  z.object({ state: z.literal('ready'), description: z.string(), assetId: z.string() }),
  z.object({
    state: z.literal('unavailable'),
    description: z.string(),
    runId: z.string(),
    reason: z.string(),
  }),
  // 22.3: the project uses a reusable creator; its pinned portrait is never regenerated here.
  z.object({
    state: z.literal('creator'),
    description: z.string(),
    creatorId: z.string(),
    portraitId: z.string(),
  }),
]);

export type ActorImageState = z.infer<typeof actorImageSchema>;

/** metadata.ugc.actorImage as stored (raw, for compare-and-set) and parsed (null if absent/bad). */
export function actorImageOf(metadata: Prisma.JsonValue | null | undefined): {
  raw: Prisma.JsonValue | null;
  state: ActorImageState | null;
} {
  const ugc =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, Prisma.JsonValue>).ugc
      : undefined;
  const raw =
    ugc && typeof ugc === 'object' && !Array.isArray(ugc)
      ? ((ugc as Record<string, Prisma.JsonValue>).actorImage ?? null)
      : null;
  const parsed = actorImageSchema.safeParse(raw);
  return { raw, state: parsed.success ? parsed.data : null };
}

export type PortraitStep =
  | { kind: 'use'; assetId: string }
  | { kind: 'none'; reason: string }
  | { kind: 'wait' }
  | { kind: 'claim' };

/** What a shot does with the stored state (pure; see the module comment). */
export function nextPortraitStep(
  state: ActorImageState | null,
  input: { description: string; runId: string; now: number },
): PortraitStep {
  if (!state || state.description !== input.description) return { kind: 'claim' };
  switch (state.state) {
    case 'ready':
      return { kind: 'use', assetId: state.assetId };
    case 'unavailable':
      return state.runId === input.runId
        ? { kind: 'none', reason: state.reason }
        : { kind: 'claim' };
    case 'generating':
      return input.now - state.claimedAt < PORTRAIT_CLAIM_STALE_MS
        ? { kind: 'wait' }
        : { kind: 'claim' };
    case 'creator':
      // Only reached when the creator's portrait is gone (ensureActorPortrait reads it first):
      // make a one-off portrait from the same description.
      return { kind: 'claim' };
  }
}

/** Where the portrait state lives (Prisma below; an in-memory one in the tests). */
export interface PortraitStore {
  /** The project's stored state, or null when the project is not this organisation's. */
  read(
    projectId: string,
  ): Promise<{ raw: Prisma.JsonValue | null; state: ActorImageState | null } | null>;
  /** Replace the state only if it is still `expected` (raw, as read); null removes it. */
  compareAndSet(
    projectId: string,
    expected: Prisma.JsonValue | null,
    next: ActorImageState | null,
  ): Promise<boolean>;
}

type PortraitDb = Pick<PrismaClient, 'videoProject' | '$executeRaw'>;

/** metadata.ugc.actorImage on studio.video_projects, changed atomically with jsonb operators. */
export function prismaPortraitStore(db: PortraitDb, organisationId: string): PortraitStore {
  return {
    async read(projectId) {
      const project = await db.videoProject.findFirst({
        where: { id: projectId, organisationId },
        select: { metadata: true },
      });
      return project ? actorImageOf(project.metadata) : null;
    },
    async compareAndSet(projectId, expected, next) {
      const before = expected === null ? null : JSON.stringify(expected);
      const count =
        next === null
          ? await db.$executeRaw`
              UPDATE "studio"."video_projects"
              SET "metadata" = "metadata" #- '{ugc,actorImage}', "updatedAt" = now()
              WHERE "id" = ${projectId} AND "organisationId" = ${organisationId}
                AND ("metadata"->'ugc'->'actorImage') IS NOT DISTINCT FROM ${before}::jsonb`
          : await db.$executeRaw`
              UPDATE "studio"."video_projects"
              SET "metadata" = jsonb_set("metadata", '{ugc,actorImage}', ${JSON.stringify(next)}::jsonb, true),
                  "updatedAt" = now()
              WHERE "id" = ${projectId} AND "organisationId" = ${organisationId}
                AND jsonb_typeof("metadata"->'ugc') = 'object'
                AND ("metadata"->'ugc'->'actorImage') IS NOT DISTINCT FROM ${before}::jsonb`;
      return count === 1;
    },
  };
}

export interface ActorPortrait {
  /** The project's portrait asset (video_assets.id), or the creator's portrait (22.3). */
  assetId: string;
  /** Signed URL of the stored portrait (what the actor providers fetch). */
  url: string;
  /** 22.3: set when the portrait is a reusable creator's. */
  creatorId?: string;
}

export interface PortraitInput {
  projectId: string;
  organisationId: string;
  runId: string;
  planTier: PlanTier;
  style: UgcStyle;
  /** For logs only: the shot that asked. */
  shotId?: string;
  /** Tests inject an in-memory store; production uses prismaPortraitStore. */
  store?: PortraitStore;
}

/** Why no portrait can be made right now (the clips go on without one), or null to rethrow. */
export function portraitUnavailableReason(err: unknown): string | null {
  if (isGenerationRefusal(err)) return 'content_policy';
  return avatarUnavailableReason(err);
}

async function readyPortrait(
  deps: PipelineDeps,
  organisationId: string,
  assetId: string,
): Promise<ActorPortrait | null> {
  const asset = await deps.db.videoAsset.findFirst({
    where: { id: assetId, organisationId, kind: 'IMAGE' },
    select: { id: true, s3Bucket: true, s3Key: true },
  });
  if (!asset) return null;
  return { assetId: asset.id, url: await deps.storage.signedUrl(asset.s3Bucket, asset.s3Key) };
}

/**
 * 22.3: the creator portrait a project pinned (still used when the creator has since been retired
 * or given a new portrait), or null when it no longer exists.
 */
async function creatorPortrait(
  deps: PipelineDeps,
  organisationId: string,
  creator: NonNullable<UgcStyle['creator']>,
): Promise<ActorPortrait | null> {
  const row = await deps.db.creatorPortrait.findFirst({
    where: { id: creator.portraitId, organisationId, creatorId: creator.id },
    select: { id: true, s3Bucket: true, s3Key: true },
  });
  if (!row) return null;
  return {
    assetId: row.id,
    url: await deps.storage.signedUrl(row.s3Bucket, row.s3Key),
    creatorId: creator.id,
  };
}

/**
 * The project's actor portrait: the stored one, else made now (by the first shot to ask), else
 * null when none can be made for this run. Throws RateDeferredError while another shot makes it.
 */
export async function ensureActorPortrait(
  deps: PipelineDeps,
  input: PortraitInput,
): Promise<ActorPortrait | null> {
  // 22.3: a reusable creator's pinned portrait: nothing is generated, every clip (and every
  // regenerated clip) gets the same face.
  if (input.style.creator) {
    const portrait = await creatorPortrait(deps, input.organisationId, input.style.creator);
    if (portrait) return portrait;
    deps.logger.warn(
      { projectId: input.projectId, creatorId: input.style.creator.id },
      'the creator portrait is gone; making a one-off portrait from the same description',
    );
  }
  const store = input.store ?? prismaPortraitStore(deps.db, input.organisationId);
  const description = actorDescription(input.style);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const current = await store.read(input.projectId);
    if (!current) throw new NotFoundError('Project not found');
    const step = nextPortraitStep(current.state, {
      description,
      runId: input.runId,
      now: deps.now(),
    });
    if (step.kind === 'none') return null;
    if (step.kind === 'wait') {
      throw new RateDeferredError(PORTRAIT_DEFER_ID, PORTRAIT_WAIT_MS, {
        reason: 'actor_portrait_generating',
        projectId: input.projectId,
      });
    }
    if (step.kind === 'use') {
      const ready = await readyPortrait(deps, input.organisationId, step.assetId);
      if (ready) return ready;
      // The asset row is gone (deleted): make a new portrait.
    }
    const claim: ActorImageState = {
      state: 'generating',
      description,
      claimedAt: deps.now(),
      claimId: randomUUID(),
    };
    if (await store.compareAndSet(input.projectId, current.raw, claim)) {
      return makePortrait(deps, input, store, claim);
    }
    // Another shot changed the state first: look again.
  }
  throw new RateDeferredError(PORTRAIT_DEFER_ID, PORTRAIT_WAIT_MS, {
    reason: 'actor_portrait_contended',
    projectId: input.projectId,
  });
}

async function markUnavailable(
  deps: PipelineDeps,
  input: PortraitInput,
  store: PortraitStore,
  claim: Extract<ActorImageState, { state: 'generating' }>,
  reason: string,
): Promise<null> {
  await store.compareAndSet(input.projectId, claim, {
    state: 'unavailable',
    description: claim.description,
    runId: input.runId,
    reason,
  });
  deps.logger.warn(
    { projectId: input.projectId, shotId: input.shotId, reason },
    'no UGC actor portrait for this run; actor clips use the description and seed only',
  );
  return null;
}

async function makePortrait(
  deps: PipelineDeps,
  input: PortraitInput,
  store: PortraitStore,
  claim: Extract<ActorImageState, { state: 'generating' }>,
): Promise<ActorPortrait | null> {
  const prompt = actorPortraitPrompt(input.style);
  // Defence in depth: the description is built from presets only, so this never matches today.
  if (checkRealPersonRequest(prompt, actorDescription(input.style)).refused)
    return markUnavailable(deps, input, store, claim, 'real_person_check');
  let assetId: string;
  let contentType: string;
  try {
    const run = await runProvider(
      {
        // The IMAGE_STILL route (text_to_image is routed as a shot need).
        need: { kind: 'shot', visualTreatment: 'IMAGE_STILL', durationSec: 5 },
        planTier: input.planTier,
        request: {
          capability: 'text_to_image',
          organisationId: input.organisationId,
          projectId: input.projectId,
          prompt,
          aspectRatio: PORTRAIT_ASPECT,
        },
      },
      deps,
    );
    ({ assetId, contentType } = await recordPortrait(deps, input, run, prompt));
  } catch (err) {
    const reason = portraitUnavailableReason(err);
    if (reason) return markUnavailable(deps, input, store, claim, reason);
    // Transient (or a pause / kill switch): free the claim so the retried job makes it.
    await store.compareAndSet(input.projectId, claim, null);
    throw err;
  }
  if (!PORTRAIT_TYPES.has(contentType))
    return markUnavailable(deps, input, store, claim, 'unsupported_image_type');
  const ready: ActorImageState = { state: 'ready', description: claim.description, assetId };
  if (!(await store.compareAndSet(input.projectId, claim, ready))) {
    deps.logger.warn(
      { projectId: input.projectId, assetId },
      'actor portrait claim was taken over while generating; this shot uses its own portrait',
    );
  }
  const portrait = await readyPortrait(deps, input.organisationId, assetId);
  if (!portrait) throw new NotFoundError('Actor portrait asset not found');
  deps.logger.info({ projectId: input.projectId, assetId }, 'UGC actor portrait generated');
  return portrait;
}

function typeOfKey(key: string): string {
  if (/\.png$/i.test(key)) return 'image/png';
  if (/\.jpe?g$/i.test(key)) return 'image/jpeg';
  return 'application/octet-stream';
}

/** Store the image as a project IMAGE asset (not a shot's, not in the image library). */
async function recordPortrait(
  deps: PipelineDeps,
  input: PortraitInput,
  run: ProviderRunResult,
  prompt: string,
): Promise<{ assetId: string; contentType: string }> {
  const meta = (run.output.metadata ?? {}) as Record<string, unknown>;
  const providerId = run.decision.providerId;
  let bucket = typeof meta.s3Bucket === 'string' ? meta.s3Bucket : undefined;
  let key = typeof meta.s3Key === 'string' ? meta.s3Key : undefined;
  let contentType = key ? typeOfKey(key) : 'application/octet-stream';
  let bytes: number | null = null;
  if (!bucket || !key) {
    if (!run.output.url) throw new NotFoundError(`${providerId} returned no portrait`);
    const copied = await copyUrlToStorage(
      deps.storage,
      {
        url: run.output.url,
        bucket: deps.config.assetsBucket,
        key: providerOutputKey({
          organisationId: input.organisationId,
          projectId: input.projectId,
          providerId,
          extension: 'png',
        }),
        fallbackContentType: 'image/png',
        providerId,
      },
      run.fetchOutput ?? deps.fetch,
    );
    bucket = copied.bucket;
    key = copied.key;
    contentType = copied.contentType;
    bytes = copied.bytes;
  }
  const job = await deps.db.providerJob.findUnique({
    where: { id: run.providerJobRowId },
    select: { costPence: true },
  });
  const model = typeof meta.model === 'string' ? `:${meta.model}` : '';
  const asset = await deps.db.videoAsset.create({
    data: {
      organisationId: input.organisationId,
      projectId: input.projectId,
      shotId: null,
      kind: 'IMAGE',
      source: `${providerId}${model}`,
      s3Bucket: bucket,
      s3Key: key,
      fileSizeBytes: bytes === null ? null : BigInt(bytes),
      providerJobId: run.providerJobRowId,
      costPence: job?.costPence ?? 0,
      metadata: {
        ...meta,
        role: ACTOR_PORTRAIT_ROLE,
        prompt,
        description: actorDescription(input.style),
      } as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return { assetId: asset.id, contentType };
}
