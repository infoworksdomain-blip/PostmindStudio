import { randomInt } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import { fileField, textField } from '../api/multipart';
import type { AssetStorage } from '../storage';
import {
  CREATOR_PORTRAIT_TYPES,
  creatorPortraitKey,
  sniffPortraitType,
} from '../ugc/creator-portrait';
import { creatorDescription, MAX_UGC_SEED } from '../ugc/style';
import {
  assertCreatorRoom,
  assertCreatorTexts,
  createCreatorInput,
  type CreatorResult,
} from './creators';

// BACKLOG 22.3 — a creator from an uploaded photo of a real person. Allowed ONLY with the
// uploader's explicit attestation that they have that person's consent and the rights to use
// their likeness (the acceptable use policy forbids depicting real people without consent); the
// attestation is stored on the portrait row with who made it and when, and audited by the route.
// The texts are real-person checked like a generated creator's (an obvious celebrity or
// look-alike request is refused), and the image must be a PNG or JPEG (what Veo accepts).

export const MAX_CREATOR_PHOTO_BYTES = 10 * 1024 * 1024;
/** The whole multipart body (photo + fields). */
export const MAX_CREATOR_UPLOAD_BYTES = MAX_CREATOR_PHOTO_BYTES + 64_000;
/** Recorded with the attestation (the UI shows the same words, translated). */
export const CREATOR_CONSENT_STATEMENT =
  'I confirm that the person in this photo has given their consent, and that I have the rights, for their likeness to be used to generate videos for this business.';

const uploadFields = createCreatorInput.extend({
  consent: z.literal('true', {
    error: 'consent must be true: you must have the person’s consent and the rights to the photo',
  }),
});

export interface CreatorUploadInput {
  fields: z.infer<typeof uploadFields>;
  photo: { bytes: Uint8Array; contentType: 'image/png' | 'image/jpeg'; filename: string };
}

/** Validates the multipart form: fields, consent=true and one PNG/JPEG photo ≤ 10 MB. */
export async function parseCreatorUploadForm(form: FormData): Promise<CreatorUploadInput> {
  const parsed = uploadFields.safeParse({
    name: textField(form, 'name'),
    gender: textField(form, 'gender'),
    ageRange: textField(form, 'ageRange'),
    setting: textField(form, 'setting'),
    appearance: textField(form, 'appearance') || undefined,
    voiceTone: textField(form, 'voiceTone') || undefined,
    consent: textField(form, 'consent'),
  });
  if (!parsed.success)
    throw new ValidationError('Creator upload failed validation', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  const file = fileField(form, 'photo');
  if (!file) throw new ValidationError('photo is required (multipart field "photo")');
  if (file.size === 0) throw new ValidationError('photo is empty');
  if (file.size > MAX_CREATOR_PHOTO_BYTES) throw new ValidationError('photo must be at most 10 MB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = sniffPortraitType(bytes);
  if (!contentType) throw new ValidationError('photo must be a PNG or JPEG image');
  return {
    fields: parsed.data,
    photo: { bytes, contentType, filename: (file.name || 'photo').slice(0, 120) },
  };
}

/** POST /businesses/:id/creators/upload — a READY creator from a consented photo. */
export async function uploadCreator(
  deps: { db: PrismaClient; storage: AssetStorage; bucket: string; now: () => number },
  tenant: Pick<TenantContext, 'organisationId' | 'userId'>,
  businessId: string,
  input: CreatorUploadInput,
): Promise<CreatorResult> {
  const scope = { organisationId: tenant.organisationId, businessId };
  const { fields, photo } = input;
  assertCreatorTexts(fields.name, fields.appearance, fields.voiceTone, photo.filename);
  await assertCreatorRoom(deps.db, scope);
  const creator = await deps.db.creator.create({
    data: {
      ...scope,
      name: fields.name,
      gender: fields.gender,
      ageRange: fields.ageRange,
      setting: fields.setting,
      appearance: fields.appearance || null,
      voiceTone: fields.voiceTone || null,
      description: creatorDescription({
        gender: fields.gender,
        ageRange: fields.ageRange,
        appearance: fields.appearance ?? null,
        seed: randomInt(0, MAX_UGC_SEED),
      }),
      createdByUserId: tenant.userId,
    },
  });
  const key = creatorPortraitKey(
    tenant.organisationId,
    creator.id,
    CREATOR_PORTRAIT_TYPES[photo.contentType] ?? 'png',
  );
  await deps.storage.put({
    bucket: deps.bucket,
    key,
    body: photo.bytes,
    contentType: photo.contentType,
  });
  const attestedAt = new Date(deps.now());
  const ready = await deps.db.$transaction(async (tx) => {
    const portrait = await tx.creatorPortrait.create({
      data: {
        ...scope,
        creatorId: creator.id,
        source: 'UPLOAD',
        s3Bucket: deps.bucket,
        s3Key: key,
        contentType: photo.contentType,
        consentAttestedByUserId: tenant.userId,
        consentAttestedAt: attestedAt,
        consentStatement: CREATOR_CONSENT_STATEMENT,
        createdByUserId: tenant.userId,
      },
    });
    return tx.creator.update({
      where: { id: creator.id },
      data: { portraitId: portrait.id, status: 'READY' },
    });
  });
  return { creator: ready, portraitError: null };
}
