import { randomUUID } from 'node:crypto';
import { ProviderError, ValidationError } from '../../errors';
import { copyUrlToStorage } from '../pipeline/persist';
import { runProvider, type ProviderRunDeps } from '../pipeline/provider-run';
import type { PlanTier } from '../providers/router';
import type { AssetStorage } from '../storage';
import { PORTRAIT_ASPECT } from './prompt';
import { SETTING_TEXT, type UgcSetting } from './style';

// BACKLOG 22.3 — a reusable creator's portrait. Made the same way as a project's one-off actor
// portrait (ugc/portrait.ts, 21.4a): Studio's own image generation through the IMAGE_STILL route
// (OpenAI gpt-image-2, then fal / Ideogram), so the router, plan tier, budgets, per-day cost caps,
// cost tracking and kill switch apply exactly as for any still. The prompt is built from the
// creator's presets and real-person-checked look notes only, and always asks for a fictional
// person. Unlike a project's portrait (a 30-day intermediate), a creator's portrait is kept: the
// image is copied to orgs/<org>/creators/<creatorId>/… in the assets bucket (never the image
// library), which the organisation and business hard deletes remove.

/** Veo fetches reference images as PNG or JPEG only (veo.ts fetchImage); Kling takes either. */
export const CREATOR_PORTRAIT_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

/** The portrait prompt: the creator's fixed look text and setting, a fictional person only. */
export function creatorPortraitPrompt(input: {
  description: string;
  setting: UgcSetting;
  instructions?: string | null;
}): string {
  const extra = input.instructions?.trim().replace(/\s+/g, ' ');
  return [
    `Photorealistic vertical smartphone selfie photo of a fictional person who does not exist: ${input.description}, in ${SETTING_TEXT[input.setting]}.`,
    'Head and shoulders, facing the camera and looking into the lens with a relaxed, friendly expression; natural daylight; the whole face and hair clearly visible and in sharp focus.',
    // No "celebrity" here: the real-person check (real-person.ts) matches that word.
    'An everyday, ordinary-looking person; not anyone famous and not any real, identifiable person.',
    'Nothing in their hands. No text, captions, logos or watermarks.',
    ...(extra ? [`Adjustments: ${extra}.`] : []),
  ].join(' ');
}

/** PNG or JPEG from the first bytes, else null (WebP, GIF, anything else). */
export function sniffPortraitType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  return null;
}

/** Where a creator's portraits are kept (assets bucket; no provider-output tag, no expiry). */
export function creatorPortraitKey(
  organisationId: string,
  creatorId: string,
  extension: string,
): string {
  for (const segment of [organisationId, creatorId, extension])
    if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(segment))
      throw new ValidationError('Unsafe creator portrait key segment');
  return `orgs/${organisationId}/creators/${creatorId}/${randomUUID()}.${extension}`;
}

export interface CreatorPortraitDeps {
  providers: ProviderRunDeps;
  storage: AssetStorage;
  /** The assets bucket. */
  bucket: string;
}

export interface GeneratedCreatorPortrait {
  s3Bucket: string;
  s3Key: string;
  contentType: 'image/png' | 'image/jpeg';
  prompt: string;
  providerId: string;
  providerJobId: string;
  costPence: number;
}

/**
 * Generate and keep one portrait. Throws what runProvider throws (refusals, account problems,
 * kill switch, budget caps), and ProviderError unsupported_image_type for a WebP/GIF result.
 */
export async function generateCreatorPortrait(
  deps: CreatorPortraitDeps,
  input: {
    organisationId: string;
    creatorId: string;
    planTier: PlanTier;
    description: string;
    setting: UgcSetting;
    instructions?: string | null;
  },
): Promise<GeneratedCreatorPortrait> {
  const prompt = creatorPortraitPrompt(input);
  const run = await runProvider(
    {
      // The IMAGE_STILL route (text_to_image is routed as a shot need), as for 21.4a portraits.
      need: { kind: 'shot', visualTreatment: 'IMAGE_STILL', durationSec: 5 },
      planTier: input.planTier,
      request: {
        capability: 'text_to_image',
        organisationId: input.organisationId,
        prompt,
        aspectRatio: PORTRAIT_ASPECT,
      },
    },
    deps.providers,
  );
  const providerId = run.decision.providerId;
  const meta = (run.output.metadata ?? {}) as Record<string, unknown>;
  const fromBucket = typeof meta.s3Bucket === 'string' ? meta.s3Bucket : undefined;
  const fromKey = typeof meta.s3Key === 'string' ? meta.s3Key : undefined;
  let stored: { bucket: string; key: string; contentType: 'image/png' | 'image/jpeg' };
  if (fromBucket && fromKey) {
    // The adapter kept the bytes as a provider output (30-day intermediate): keep a copy.
    const size = await deps.storage.size(fromBucket, fromKey);
    const bytes = await deps.storage.readRange(fromBucket, fromKey, 0, size - 1);
    const contentType = sniffPortraitType(bytes);
    if (!contentType) throw unsupported(providerId);
    const key = creatorPortraitKey(
      input.organisationId,
      input.creatorId,
      CREATOR_PORTRAIT_TYPES[contentType] ?? 'png',
    );
    await deps.storage.put({ bucket: deps.bucket, key, body: bytes, contentType });
    stored = { bucket: deps.bucket, key, contentType };
  } else {
    if (!run.output.url) throw new ProviderError(providerId, 'unknown', 'No portrait', true);
    const copied = await copyUrlToStorage(
      deps.storage,
      {
        url: run.output.url,
        bucket: deps.bucket,
        key: creatorPortraitKey(input.organisationId, input.creatorId, 'png'),
        fallbackContentType: 'image/png',
        providerId,
      },
      run.fetchOutput ?? deps.providers.fetch,
    );
    const contentType = copied.contentType;
    if (contentType !== 'image/png' && contentType !== 'image/jpeg') {
      await deps.storage.delete(copied.bucket, copied.key).catch(() => undefined);
      throw unsupported(providerId);
    }
    stored = { bucket: copied.bucket, key: copied.key, contentType };
  }
  const job = await deps.providers.db.providerJob.findUnique({
    where: { id: run.providerJobRowId },
    select: { costPence: true },
  });
  const model = typeof meta.model === 'string' ? `:${meta.model}` : '';
  return {
    s3Bucket: stored.bucket,
    s3Key: stored.key,
    contentType: stored.contentType,
    prompt,
    providerId: `${providerId}${model}`,
    providerJobId: run.providerJobRowId,
    costPence: job?.costPence ?? 0,
  };
}

function unsupported(providerId: string): ProviderError {
  return new ProviderError(
    providerId,
    'unsupported_image_type',
    'The portrait is not a PNG or JPEG image',
    false,
  );
}
