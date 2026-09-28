import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRequest } from '../../src/lib/studio/providers/interface';
import type { ProjectJobData } from '../../src/lib/studio/queue/queues';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import { createHarness, createProject } from '../helpers/pipeline-harness';

// 15.C5 media side: an Arabic project narrates with the Arabic default voice (or the brand
// clone, which always wins), sends the language to TTS and to the word-timing transcriber.

const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = 'voicelang-';

describe.skipIf(!hasDb)('script language → voice and transcription', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    const projects = await db.videoProject.findMany({
      where: { organisationId: { startsWith: PREFIX } },
      select: { id: true },
    });
    const ids = projects.map((p) => p.id);
    await db.textOverlay.deleteMany({ where: { shot: { script: { projectId: { in: ids } } } } });
    await db.videoShot.deleteMany({ where: { script: { projectId: { in: ids } } } });
    await db.videoScript.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoBrief.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoAsset.deleteMany({ where: { projectId: { in: ids } } });
    await db.providerJob.deleteMany({ where: { organisationId: { startsWith: PREFIX } } });
    await db.providerUsage.deleteMany({ where: { organisationId: { startsWith: PREFIX } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.brandKit.deleteMany({ where: { organisationId: { startsWith: PREFIX } } });
    await db.voiceProfile.deleteMany({ where: { organisationId: { startsWith: PREFIX } } });
    await db.$disconnect();
  });

  async function runArabic(organisationId: string) {
    const h = createHarness(db);
    const { project, runId } = await createProject(db, { organisationId });
    await db.videoProject.update({ where: { id: project.id }, data: { language: 'ar' } });
    const job: ProjectJobData = {
      projectId: project.id,
      organisationId,
      runId,
      planTier: 'STANDARD',
    };
    await h.queue.add('plan-project', job);
    await drainInline(h.queue, h.deps);
    const scripts = await db.videoScript.findMany({ where: { projectId: project.id } });
    const tts = h.adapters.elevenlabs.requests.filter(
      (r): r is Extract<ProviderRequest, { capability: 'tts' }> => r.capability === 'tts',
    );
    const transcription = h.adapters.assemblyai.requests.filter(
      (r): r is Extract<ProviderRequest, { capability: 'transcription' }> =>
        r.capability === 'transcription',
    );
    return { scripts, tts, transcription };
  }

  it('uses the per-language default voice and sends the language to TTS and transcription', async () => {
    vi.stubEnv('ELEVENLABS_DEFAULT_VOICE_ID_AR', 'voice-arabic');
    const { scripts, tts, transcription } = await runArabic(`${PREFIX}${randomUUID()}`);
    expect(scripts.map((s) => s.language)).toEqual(['ar']);
    expect(tts.length).toBeGreaterThan(0);
    for (const request of tts) {
      expect(request.voiceId).toBe('voice-arabic');
      expect(request.languageCode).toBe('ar');
    }
    expect(transcription.length).toBeGreaterThan(0);
    for (const request of transcription) expect(request.languageCode).toBe('ar');
  });

  it('falls back to the global default voice when no Arabic voice is configured', async () => {
    vi.stubEnv('ELEVENLABS_DEFAULT_VOICE_ID_AR', '');
    const { tts } = await runArabic(`${PREFIX}${randomUUID()}`);
    expect(tts.every((r) => r.voiceId === 'voice-default')).toBe(true);
  });

  it('keeps a READY brand-kit clone ahead of the language default', async () => {
    vi.stubEnv('ELEVENLABS_DEFAULT_VOICE_ID_AR', 'voice-arabic');
    const organisationId = `${PREFIX}${randomUUID()}`;
    const profile = await db.voiceProfile.create({
      data: {
        organisationId,
        businessId: 'biz-1',
        name: 'Owner',
        provider: 'elevenlabs',
        providerVoiceId: 'voice-clone',
        languagesSupported: ['en'],
        state: 'READY',
      },
    });
    await db.brandKit.create({
      data: {
        organisationId,
        businessId: 'biz-1',
        name: 'Default',
        isDefault: true,
        colourPalette: [],
        ctaTemplates: [],
        voiceProfileId: profile.id,
      },
    });
    const { tts } = await runArabic(organisationId);
    expect(tts.length).toBeGreaterThan(0);
    expect(tts.every((r) => r.voiceId === 'voice-clone' && r.languageCode === 'ar')).toBe(true);
  });
});
