import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as consentRoute from '../../src/app/api/studio/voice-profiles/[id]/consent-check/route';
import * as brandKitRoute from '../../src/app/api/studio/brand-kits/[id]/route';
import * as previewRoute from '../../src/app/api/studio/voice-profiles/[id]/preview/route';
import * as voicesRoute from '../../src/app/api/studio/voice-profiles/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { VoiceCloningClient } from '../../src/lib/studio/providers/elevenlabs-voices';
import type { TenantContext } from '../../src/lib/tenant';
import { call, installApi, multipart, tenant } from '../helpers/api-harness';
import { createHarness } from '../helpers/pipeline-harness';

// 15.C7 — the consent recording is transcribed and matched before a clone is usable
// (spec 10.2). Real routes and Postgres; the transcriber is the harness's scripted AssemblyAI.

const hasDb = Boolean(process.env.DATABASE_URL);
const STATEMENT = 'I, Amara Okafor, consent to PostMind Studio cloning my voice.';

describe.skipIf(!hasDb)('voice consent check (15.C7)', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-consent-${randomUUID()}`;
  const ent = (): TenantContext => ({
    ...tenant(org),
    organisation: { id: org, planTier: 'ENTERPRISE' },
  });
  const tokens = {
    owner: ent(),
    stranger: {
      ...tenant(`api-consent-other-${randomUUID()}`),
      organisation: { id: 'x', planTier: 'ENTERPRISE' },
    },
  };
  let h: ReturnType<typeof createHarness>;
  let api: ReturnType<typeof installApi>;
  let heard: string | Error;

  beforeEach(() => {
    h = createHarness(db);
    api = installApi(db, tokens, {
      queue: h.queue,
      publishing: h.deps.publishing,
      pipeline: h.deps,
    });
    const client: VoiceCloningClient = {
      providerId: 'elevenlabs',
      addVoice: async () => ({ voiceId: `el-${randomUUID()}`, requiresVerification: false }),
      deleteVoice: async () => undefined,
    };
    api.deps.voiceCloning = client;
    heard = STATEMENT;
    h.adapters.assemblyai.respond = () =>
      heard instanceof Error
        ? {
            state: 'failed',
            error: { class: 'invalid_request', message: heard.message, retryable: false },
          }
        : { state: 'succeeded', output: { metadata: { text: heard } } };
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.brandKit.deleteMany({ where: { organisationId: org } });
    await db.voiceProfile.deleteMany({ where: { organisationId: org } });
    await db.providerJob.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  async function create() {
    const form = new FormData();
    for (const [k, v] of Object.entries({
      name: 'Amara',
      businessId: 'biz-1',
      speakerName: 'Amara Okafor',
      consentStatement: STATEMENT,
      consent: 'true',
    }))
      form.append(k, v);
    form.append('consentRecording', new File([new Uint8Array(8)], 'c.mp3', { type: 'audio/mpeg' }));
    form.append('samples', new File([new Uint8Array(16)], 's.mp3', { type: 'audio/mpeg' }));
    const { body, headers } = await multipart(form);
    const res = await call(voicesRoute.POST, { method: 'POST', token: 'owner', body, headers });
    expect(res.status).toBe(201);
    return res.json.voiceProfile as { id: string; state: string; consentCheck: string };
  }

  it('passes when the recording says the statement (small transcription slips allowed)', async () => {
    heard = 'Um, I Amara Okafor consent to Postmind Studio cloning my voice';
    const profile = await create();
    expect(profile).toMatchObject({ state: 'READY', consentCheck: 'passed' });
    const row = await db.voiceProfile.findUniqueOrThrow({ where: { id: profile.id } });
    expect(row.consentTranscript).toContain('Amara Okafor');
    expect(h.adapters.assemblyai.requests.at(-1)).toMatchObject({
      capability: 'transcription',
      mediaUrl: expect.stringContaining('voice-consent/'),
    });
  });

  it('a mismatch keeps the profile PENDING_REVIEW: not previewable, not linkable', async () => {
    heard = 'Hello, testing one two three';
    const profile = await create();
    expect(profile).toMatchObject({ state: 'PENDING_REVIEW', consentCheck: 'mismatch' });
    const preview = await call(previewRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: profile.id },
      body: { text: 'Hi' },
    });
    expect(preview.status).toBe(409);
    const kit = await db.brandKit.create({
      data: {
        organisationId: org,
        businessId: 'biz-1',
        name: 'Kit',
        colourPalette: [],
        ctaTemplates: [],
        toneKeywords: [],
        restrictedTopics: [],
      },
    });
    const link = await call(brandKitRoute.PATCH, {
      method: 'PATCH',
      token: 'owner',
      params: { id: kit.id },
      body: { voiceProfileId: profile.id },
    });
    expect(link.status).toBe(400);
  });

  it('transcription failure is "unavailable"; a re-check can pass it (audited)', async () => {
    heard = new Error('download failed');
    const profile = await create();
    expect(profile).toMatchObject({ state: 'PENDING_REVIEW', consentCheck: 'unavailable' });

    expect(
      (
        await call(consentRoute.POST, {
          method: 'POST',
          token: 'stranger',
          params: { id: profile.id },
        })
      ).status,
    ).toBe(404);
    heard = STATEMENT;
    const res = await call(consentRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: profile.id },
    });
    expect(res.status).toBe(200);
    expect(res.json.voiceProfile).toMatchObject({ state: 'READY', consentCheck: 'passed' });
    expect(res.json.similarity).toBe(1);
    expect(api.audits.some((a) => a.action === 'studio.voice_profile.consent_check')).toBe(true);
    // Only PENDING_REVIEW profiles can be re-checked.
    expect(
      (
        await call(consentRoute.POST, {
          method: 'POST',
          token: 'owner',
          params: { id: profile.id },
        })
      ).status,
    ).toBe(409);
  });
});
