import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as brandKitRoute from '../../src/app/api/studio/brand-kits/[id]/route';
import * as previewRoute from '../../src/app/api/studio/voice-profiles/[id]/preview/route';
import * as voiceRoute from '../../src/app/api/studio/voice-profiles/[id]/route';
import * as voicesRoute from '../../src/app/api/studio/voice-profiles/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { VoiceCloningClient } from '../../src/lib/studio/providers/elevenlabs-voices';
import type { TenantContext } from '../../src/lib/tenant';
import { call, installApi, multipart, tenant } from '../helpers/api-harness';
import { createHarness } from '../helpers/pipeline-harness';

// BACKLOG 13.13 — voice profiles through the real routes and Postgres, with a recording fake of
// the ElevenLabs voice-cloning client: tier gate, consent required + stored + audited, list,
// brand-kit link, preview through the TTS router, delete revokes at the provider and unlinks.

const hasDb = Boolean(process.env.DATABASE_URL);

function fakeCloning() {
  const added: Array<{ name: string; samples: number }> = [];
  const deleted: string[] = [];
  const client: VoiceCloningClient = {
    providerId: 'elevenlabs',
    async addVoice(input) {
      added.push({ name: input.name, samples: input.samples.length });
      return { voiceId: `el-voice-${added.length}`, requiresVerification: false };
    },
    async deleteVoice(voiceId) {
      deleted.push(voiceId);
    },
  };
  return { client, added, deleted };
}

describe.skipIf(!hasDb)('voice profiles API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-voice-${randomUUID()}`;
  const ent = (caps?: string[]): TenantContext => ({
    ...tenant(org, caps),
    organisation: { id: org, planTier: 'ENTERPRISE' },
  });
  const tokens = {
    owner: ent(),
    standard: tenant(org),
    reader: ent(['studio:project:read']),
    stranger: {
      ...tenant(`api-voice-other-${randomUUID()}`),
      organisation: { id: 'x', planTier: 'ENTERPRISE' },
    },
  };
  let h: ReturnType<typeof createHarness>;
  let api: ReturnType<typeof installApi>;
  let cloning: ReturnType<typeof fakeCloning>;

  beforeEach(() => {
    h = createHarness(db);
    api = installApi(db, tokens, {
      queue: h.queue,
      publishing: h.deps.publishing,
      pipeline: h.deps,
    });
    cloning = fakeCloning();
    api.deps.voiceCloning = cloning.client;
    // 15.C7: the consent recording says the statement (the scripted transcriber hears it).
    h.adapters.assemblyai.respond = () => ({
      state: 'succeeded',
      output: {
        metadata: { text: 'I, Amara Okafor, consent to PostMind Studio cloning my voice.' },
      },
    });
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.brandKit.deleteMany({ where: { organisationId: org } });
    await db.voiceProfile.deleteMany({ where: { organisationId: org } });
    await db.providerJob.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  async function create(token = 'owner', overrides: Record<string, string | null> = {}) {
    const form = new FormData();
    const fields: Record<string, string | null> = {
      name: 'Amara (owner)',
      businessId: 'biz-1',
      speakerName: 'Amara Okafor',
      consentStatement: 'I, Amara Okafor, consent to PostMind Studio cloning my voice.',
      consent: 'true',
      ...overrides,
    };
    for (const [k, v] of Object.entries(fields)) if (v !== null) form.append(k, v);
    form.append(
      'consentRecording',
      new File([new Uint8Array(8)], 'consent.mp3', { type: 'audio/mpeg' }),
    );
    form.append('samples', new File([new Uint8Array(16)], 'sample.mp3', { type: 'audio/mpeg' }));
    const { body, headers } = await multipart(form);
    return call(voicesRoute.POST, { method: 'POST', token, body, headers });
  }

  it('creates a profile with recorded, audited consent (Plus and above; P4)', async () => {
    expect((await create('standard')).status).toBe(403);
    expect((await create('reader')).status).toBe(403);
    expect((await create('owner', { consent: null })).status).toBe(400);
    expect(cloning.added).toHaveLength(0);

    const res = await create();
    expect(res.status).toBe(201);
    const profile = res.json.voiceProfile as Record<string, unknown>;
    expect(profile).toMatchObject({
      name: 'Amara (owner)',
      state: 'READY',
      provider: 'elevenlabs',
    });
    expect(profile).not.toHaveProperty('providerVoiceId');
    expect(profile).not.toHaveProperty('consentS3Key');
    expect(cloning.added).toEqual([{ name: expect.stringContaining('Amara (owner)'), samples: 1 }]);
    const row = await db.voiceProfile.findUniqueOrThrow({ where: { id: profile.id as string } });
    expect(row.consentGivenByUserId).toBe('user-1');
    expect(row.consentS3Key).toContain(`orgs/${org}/voice-consent/`);
    expect(h.objects.has(`${row.consentS3Bucket}/${row.consentS3Key}`)).toBe(true);
    const audit = api.audits.find((a) => a.action === 'studio.voice_profile.create');
    expect(audit?.metadata).toMatchObject({
      speakerName: 'Amara Okafor',
      consentStatement: expect.stringContaining('consent'),
    });
  });

  it('17.8: records the consent statement locale and catalogue key with the consent', async () => {
    const res = await create('owner', {
      consentStatementLocale: 'fr',
      consentStatementKey: 'business.voice.cloneDialog.consentPhrase',
    });
    expect(res.status).toBe(201);
    const id = (res.json.voiceProfile as { id: string }).id;
    const row = await db.voiceProfile.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      consentStatementLocale: 'fr',
      consentStatementKey: 'business.voice.cloneDialog.consentPhrase',
    });
    const audit = api.audits
      .filter((a) => a.action === 'studio.voice_profile.create' && a.resource.id === id)
      .at(-1);
    expect(audit?.metadata).toMatchObject({
      consentStatementLocale: 'fr',
      consentStatementKey: 'business.voice.cloneDialog.consentPhrase',
    });
    expect((await create('owner', { consentStatementLocale: 'klingon' })).status).toBe(400);
  });

  it('501 when no voice-cloning provider is configured', async () => {
    api.deps.voiceCloning = undefined;
    expect((await create()).status).toBe(501);
  });

  it('lists, links to a brand kit, previews, then deletes (revoked + unlinked)', async () => {
    const created = await create();
    const id = (created.json.voiceProfile as { id: string }).id;
    const list = await call(voicesRoute.GET, {
      token: 'reader',
      path: '/api/studio/voice-profiles?businessId=biz-1',
    });
    expect((list.json.data as Array<{ id: string }>).some((p) => p.id === id)).toBe(true);
    const other = await call(voicesRoute.GET, { token: 'stranger' });
    expect((other.json.data as unknown[]).length).toBe(0);

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
      body: { voiceProfileId: id },
    });
    expect(link.status).toBe(200);
    expect(
      (
        await call(brandKitRoute.PATCH, {
          method: 'PATCH',
          token: 'owner',
          params: { id: kit.id },
          body: { voiceProfileId: 'nope' },
        })
      ).status,
    ).toBe(400);

    const preview = await call(previewRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id },
      body: { text: 'Fresh bread every Friday' },
    });
    expect(preview.status).toBe(200);
    expect(preview.json.previewUrl).toEqual(expect.stringContaining('https://'));
    expect(h.adapters.elevenlabs.requests.at(-1)).toMatchObject({ voiceId: 'el-voice-1' });

    expect(
      (await call(voiceRoute.DELETE, { method: 'DELETE', token: 'stranger', params: { id } }))
        .status,
    ).toBe(404);
    const del = await call(voiceRoute.DELETE, { method: 'DELETE', token: 'owner', params: { id } });
    expect(del.status).toBe(200);
    expect(del.json).toMatchObject({ deleted: true, brandKitsUnlinked: 1 });
    expect(cloning.deleted).toEqual(['el-voice-1']);
    expect(
      (await db.brandKit.findUniqueOrThrow({ where: { id: kit.id } })).voiceProfileId,
    ).toBeNull();
    const row = await db.voiceProfile.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ state: 'DELETED', deletedByUserId: 'user-1' });
    expect(
      (await call(voiceRoute.DELETE, { method: 'DELETE', token: 'owner', params: { id } })).status,
    ).toBe(404);
    expect(api.audits.some((a) => a.action === 'studio.voice_profile.delete')).toBe(true);
  });
});
