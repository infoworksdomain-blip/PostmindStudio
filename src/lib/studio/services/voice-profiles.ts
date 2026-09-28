import { randomUUID } from 'node:crypto';
import type { PrismaClient, VoiceProfile } from '@prisma/client';
import { z } from 'zod';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  NotImplementedError,
  ValidationError,
} from '../../errors';
import { LOCALES } from '../../i18n/locales';
import type { TenantContext } from '../../tenant';
import { fileField, fileFields, textField } from '../api/multipart';
import { runProvider, type ProviderRunDeps } from '../pipeline/provider-run';
import type { VoiceCloningClient, VoiceSample } from '../providers/elevenlabs-voices';
import type { PlanTier } from '../providers/router';
import type { AssetStorage } from '../storage';
import { CONSENT_STATEMENT_KEYS } from './approved-statements';
import { businessIdParam } from './businesses';
import { toPlanTier } from './catalog';
import { checkConsentRecording, stateAfterConsent, type ConsentCheckResult } from './consent-check';

// BACKLOG 13.13 — voice profiles (spec 10.2 brand voice cloning, 13.4 deepfake protection):
//   - spec 13.4: "at lower tiers, only stock voices are available" → cloning needs the tier in
//     STUDIO_VOICE_CLONE_MIN_TIER (default PLUS: operator decision P4, 2026-09-28 — spec 12.4
//     lists "brand voice clone" under Plus; Playbook A-06 closed);
//   - spec 10.2: "consent recording is required — the speaker must record a specific consent
//     phrase" → every clone needs consent=true, the speaker's name, the consent statement they
//     read and a consentRecording file; the recording is kept in the assets bucket and the
//     consent is written to the audit log. 15.C7: the recording is transcribed and matched to
//     the statement (services/consent-check.ts); unless it passes, the profile stays
//     PENDING_REVIEW and is never used (POST /voice-profiles/:id/consent-check re-runs it);
//   - samples go to ElevenLabs Instant Voice Cloning and are not stored by Studio;
//   - DELETE revokes the voice at ElevenLabs, unlinks it from brand kits (narration falls back
//     to the default voice) and keeps the row (state DELETED) as the consent record.

export const MAX_SAMPLE_BYTES = 10 * 1024 * 1024;
export const MAX_SAMPLES = 5;
export const MAX_CONSENT_BYTES = 10 * 1024 * 1024;
/** Upper bound for the whole multipart body (samples + consent + fields). */
export const MAX_VOICE_UPLOAD_BYTES = MAX_SAMPLES * MAX_SAMPLE_BYTES + MAX_CONSENT_BYTES + 256_000;
export const PREVIEW_TTL_SEC = 10 * 60;

/** The phrase the UI asks the speaker to read (the statement actually read is stored). */
export const DEFAULT_CONSENT_PHRASE =
  'I, {name}, consent to PostMind Studio creating a synthetic copy of my voice for {business} videos.';

const AUDIO_TYPES: Readonly<Record<string, string>> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
};

const TIERS: readonly PlanTier[] = ['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE'];

/** Operator decision P4 (2026-09-28): voice cloning for Plus and Enterprise. */
export const DEFAULT_VOICE_CLONE_MIN_TIER: PlanTier = 'PLUS';

export function voiceCloneMinTier(env: Record<string, string | undefined> = process.env): PlanTier {
  const raw = env.STUDIO_VOICE_CLONE_MIN_TIER?.trim().toUpperCase();
  return TIERS.find((t) => t === raw) ?? DEFAULT_VOICE_CLONE_MIN_TIER;
}

export function assertVoiceCloneTier(
  tenant: TenantContext,
  env: Record<string, string | undefined> = process.env,
): void {
  const tier = toPlanTier(tenant.organisation.planTier);
  const min = voiceCloneMinTier(env);
  if (TIERS.indexOf(tier) < TIERS.indexOf(min))
    throw new ForbiddenError(`Voice cloning is available on the ${min} plan`, {
      planTier: tier,
      requiredTier: min,
    });
}

async function audioOf(file: File, field: string, maxBytes: number): Promise<VoiceSample> {
  const contentType = file.type.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!AUDIO_TYPES[contentType])
    throw new ValidationError(
      `${field} must be an audio file (MP3, WAV, M4A, AAC, OGG, WebM, FLAC)`,
    );
  if (file.size === 0) throw new ValidationError(`${field} is empty`);
  if (file.size > maxBytes)
    throw new ValidationError(`${field} must be at most ${maxBytes / 1024 / 1024} MB each`);
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    filename: (file.name || `${field}.${AUDIO_TYPES[contentType]}`).slice(0, 120),
    contentType,
  };
}

const fieldsSchema = z.object({
  name: z.string().trim().min(1).max(80),
  businessId: businessIdParam.optional(),
  speakerName: z.string().trim().min(1).max(120),
  consentStatement: z.string().trim().min(20).max(1_000),
  /**
   * 17.8: the interface locale the statement was shown in and its catalogue key (the key only
   * when the user kept the suggested wording). Recorded with the consent; the recording itself
   * stays the evidence and is matched against the statement text (consent-check.ts).
   */
  consentStatementLocale: z.enum(LOCALES).optional(),
  consentStatementKey: z.enum(CONSENT_STATEMENT_KEYS).optional(),
  description: z.string().trim().max(500).optional(),
  consent: z.literal('true', {
    error: 'consent must be true: the speaker must consent to their voice being cloned',
  }),
});

export interface VoiceProfileInput {
  fields: z.infer<typeof fieldsSchema>;
  samples: VoiceSample[];
  consentRecording: VoiceSample;
}

/** Validates the multipart form (fields, 1–5 samples ≤ 10 MB, a consent recording). */
export async function parseVoiceProfileForm(form: FormData): Promise<VoiceProfileInput> {
  const parsed = fieldsSchema.safeParse({
    name: textField(form, 'name'),
    businessId: textField(form, 'businessId') || undefined,
    speakerName: textField(form, 'speakerName'),
    consentStatement: textField(form, 'consentStatement'),
    consentStatementLocale: textField(form, 'consentStatementLocale') || undefined,
    consentStatementKey: textField(form, 'consentStatementKey') || undefined,
    description: textField(form, 'description') || undefined,
    consent: textField(form, 'consent'),
  });
  if (!parsed.success)
    throw new ValidationError('Voice profile form failed validation', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  const files = fileFields(form, 'samples');
  if (files.length === 0) throw new ValidationError('At least one voice sample is required');
  if (files.length > MAX_SAMPLES)
    throw new ValidationError(`At most ${MAX_SAMPLES} voice samples are allowed`);
  const consentFile = fileField(form, 'consentRecording');
  if (!consentFile)
    throw new ValidationError(
      'consentRecording is required: record the speaker reading the consent statement',
    );
  return {
    fields: parsed.data,
    samples: await Promise.all(files.map((f) => audioOf(f, 'samples', MAX_SAMPLE_BYTES))),
    consentRecording: await audioOf(consentFile, 'consentRecording', MAX_CONSENT_BYTES),
  };
}

/** Public shape: no storage coordinates, no provider voice id. */
export function presentVoiceProfile(row: VoiceProfile) {
  return {
    id: row.id,
    businessId: row.businessId,
    name: row.name,
    provider: row.provider,
    state: row.state,
    isDefault: row.isDefault,
    speakerName: row.speakerName,
    consentGivenAt: row.consentGivenAt,
    sampleCount: row.sampleCount,
    languagesSupported: row.languagesSupported,
    consentCheck: row.consentCheck,
    consentCheckedAt: row.consentCheckedAt,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

export interface VoiceDeps {
  db: PrismaClient;
  storage: AssetStorage;
  assetsBucket: string;
  cloning: VoiceCloningClient | undefined;
  /** 15.C7: transcription for the consent check; absent = the check is "unavailable". */
  providers?: ProviderRunDeps;
  now: () => number;
}

async function runConsentCheck(
  deps: VoiceDeps,
  tenant: TenantContext,
  input: { bucket: string; key: string; statement: string; speakerName: string },
): Promise<ConsentCheckResult> {
  if (!deps.providers)
    return { check: 'unavailable', transcript: null, similarity: null, reason: 'no transcription' };
  return checkConsentRecording(deps.providers, {
    organisationId: tenant.organisationId,
    planTier: toPlanTier(tenant.organisation.planTier),
    mediaUrl: await deps.storage.signedUrl(input.bucket, input.key),
    statement: input.statement,
    speakerName: input.speakerName,
  });
}

function requireCloning(cloning: VoiceCloningClient | undefined): VoiceCloningClient {
  if (!cloning)
    throw new NotImplementedError('Voice cloning needs ELEVENLABS_API_KEY to be configured');
  return cloning;
}

export async function createVoiceProfile(
  deps: VoiceDeps,
  tenant: TenantContext,
  input: VoiceProfileInput,
  env: Record<string, string | undefined> = process.env,
): Promise<VoiceProfile> {
  assertVoiceCloneTier(tenant, env);
  const cloning = requireCloning(deps.cloning);
  const { fields } = input;
  const ext = AUDIO_TYPES[input.consentRecording.contentType] ?? 'bin';
  const consentKey = `orgs/${tenant.organisationId}/voice-consent/${randomUUID()}.${ext}`;
  // Consent evidence is stored before anything is sent to the provider.
  await deps.storage.put({
    bucket: deps.assetsBucket,
    key: consentKey,
    body: input.consentRecording.bytes,
    contentType: input.consentRecording.contentType,
  });
  // 15.C7: the recording must say the statement before the clone is usable.
  const consent = await runConsentCheck(deps, tenant, {
    bucket: deps.assetsBucket,
    key: consentKey,
    statement: fields.consentStatement,
    speakerName: fields.speakerName,
  });
  const voice = await cloning.addVoice({
    name: `${fields.name} (${tenant.organisationId.slice(0, 24)})`,
    description: fields.description,
    samples: input.samples,
  });
  try {
    return await deps.db.voiceProfile.create({
      data: {
        organisationId: tenant.organisationId,
        businessId: fields.businessId ?? null,
        name: fields.name,
        provider: cloning.providerId,
        providerVoiceId: voice.voiceId,
        languagesSupported: [],
        state: stateAfterConsent(consent.check, voice.requiresVerification),
        providerVerificationRequired: voice.requiresVerification,
        consentCheck: consent.check,
        consentTranscript: consent.transcript,
        consentCheckedAt: new Date(deps.now()),
        speakerName: fields.speakerName,
        consentStatement: fields.consentStatement,
        consentStatementLocale: fields.consentStatementLocale ?? null,
        consentStatementKey: fields.consentStatementKey ?? null,
        consentGivenByUserId: tenant.userId,
        consentGivenAt: new Date(deps.now()),
        consentS3Bucket: deps.assetsBucket,
        consentS3Key: consentKey,
        sampleCount: input.samples.length,
      },
    });
  } catch (err) {
    // Never leave a cloned voice at the provider that Studio has no record of.
    await cloning.deleteVoice(voice.voiceId).catch(() => undefined);
    throw err;
  }
}

export const listVoiceProfilesQuery = z.object({ businessId: businessIdParam.optional() });

export function listVoiceProfiles(db: PrismaClient, organisationId: string, businessId?: string) {
  return db.voiceProfile.findMany({
    where: { organisationId, deletedAt: null, ...(businessId && { businessId }) },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });
}

async function findActive(db: PrismaClient, organisationId: string, id: string) {
  const row = await db.voiceProfile.findFirst({ where: { id, organisationId, deletedAt: null } });
  if (!row) throw new NotFoundError('Voice profile not found');
  return row;
}

export async function deleteVoiceProfile(
  deps: VoiceDeps,
  tenant: TenantContext,
  id: string,
): Promise<{ profile: VoiceProfile; brandKitsUnlinked: number }> {
  const row = await findActive(deps.db, tenant.organisationId, id);
  // Revoke at the provider first: if that fails the profile stays usable and visible (retry).
  if (row.provider === 'elevenlabs')
    await requireCloning(deps.cloning).deleteVoice(row.providerVoiceId);
  return deps.db.$transaction(async (tx) => {
    const unlinked = await tx.brandKit.updateMany({
      where: { organisationId: tenant.organisationId, voiceProfileId: id },
      data: { voiceProfileId: null },
    });
    const profile = await tx.voiceProfile.update({
      where: { id },
      data: {
        state: 'DELETED',
        isDefault: false,
        deletedAt: new Date(deps.now()),
        deletedByUserId: tenant.userId,
      },
    });
    return { profile, brandKitsUnlinked: unlinked.count };
  });
}

export const previewVoiceInput = z.object({ text: z.string().trim().min(1).max(300) }).strict();

/** POST /voice-profiles/:id/preview — a short TTS sample in the cloned voice. */
export async function previewVoiceProfile(
  deps: { db: PrismaClient; storage: AssetStorage; providers: ProviderRunDeps },
  tenant: TenantContext,
  id: string,
  input: z.infer<typeof previewVoiceInput>,
) {
  const row = await findActive(deps.db, tenant.organisationId, id);
  if (row.state !== 'READY')
    throw new ConflictError(
      row.state === 'REQUIRES_VERIFICATION'
        ? 'ElevenLabs needs this voice verified before it can be used'
        : `Voice profile is ${row.state}`,
    );
  const run = await runProvider(
    {
      need: { kind: 'capability', capability: 'tts' },
      planTier: toPlanTier(tenant.organisation.planTier),
      preferredProviderId: row.provider,
      request: {
        capability: 'tts',
        organisationId: tenant.organisationId,
        text: input.text,
        voiceId: row.providerVoiceId,
      },
    },
    deps.providers,
  );
  const meta = run.output.metadata as { s3Bucket?: string; s3Key?: string };
  const previewUrl =
    meta.s3Bucket && meta.s3Key
      ? await deps.storage.signedUrl(meta.s3Bucket, meta.s3Key, PREVIEW_TTL_SEC)
      : run.output.url;
  if (!previewUrl) throw new ValidationError('The voice provider returned no audio');
  return { previewUrl, expiresInSec: PREVIEW_TTL_SEC };
}

/** Brand kits may only link a usable profile of the same organisation (and business, if set). */
export async function assertLinkableVoice(
  db: PrismaClient,
  organisationId: string,
  businessId: string,
  voiceProfileId: string,
): Promise<void> {
  const row = await db.voiceProfile.findFirst({
    where: { id: voiceProfileId, organisationId, deletedAt: null },
  });
  if (!row) throw new ValidationError('voiceProfileId is not a voice profile in this organisation');
  if (row.businessId && row.businessId !== businessId)
    throw new ValidationError('That voice profile belongs to another business');
  if (row.state !== 'READY') throw new ValidationError(`That voice profile is ${row.state}`);
}

/**
 * 15.C7: POST /voice-profiles/:id/consent-check — run the consent check again on the stored
 * recording (e.g. after "unavailable"). Only a PENDING_REVIEW profile can be re-checked.
 */
export async function recheckVoiceConsent(
  deps: VoiceDeps,
  tenant: TenantContext,
  id: string,
): Promise<{ profile: VoiceProfile; similarity: number | null; reason?: string }> {
  const row = await findActive(deps.db, tenant.organisationId, id);
  if (row.state !== 'PENDING_REVIEW')
    throw new ConflictError(`Voice profile is ${row.state}; only PENDING_REVIEW can be re-checked`);
  if (!row.consentS3Bucket || !row.consentS3Key || !row.consentStatement || !row.speakerName)
    throw new ConflictError('This profile has no stored consent recording to check');
  const consent = await runConsentCheck(deps, tenant, {
    bucket: row.consentS3Bucket,
    key: row.consentS3Key,
    statement: row.consentStatement,
    speakerName: row.speakerName,
  });
  const updated = await deps.db.voiceProfile.updateMany({
    where: { id, organisationId: tenant.organisationId, state: 'PENDING_REVIEW', deletedAt: null },
    data: {
      state: stateAfterConsent(consent.check, row.providerVerificationRequired),
      consentCheck: consent.check,
      consentTranscript: consent.transcript,
      consentCheckedAt: new Date(deps.now()),
    },
  });
  if (updated.count === 0) throw new ConflictError('Voice profile changed concurrently; reload');
  return {
    profile: await findActive(deps.db, tenant.organisationId, id),
    similarity: consent.similarity,
    ...(consent.reason && { reason: consent.reason }),
  };
}
