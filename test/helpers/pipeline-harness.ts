import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { vi } from 'vitest';
import { createKillSwitch, createPrismaFlagStore } from '../../src/lib/studio/kill-switch';
import type { PipelineDeps } from '../../src/lib/studio/pipeline/deps';
import type { MediaInspector, MediaProbe } from '../../src/lib/studio/pipeline/media-probe';
import { createPrismaBudgetChecker } from '../../src/lib/studio/providers/budget';
import { createCircuitBreaker } from '../../src/lib/studio/providers/circuit-breaker';
import type { ProviderPollResult, ProviderRequest } from '../../src/lib/studio/providers/interface';
import { createPrismaProviderJobRepository } from '../../src/lib/studio/providers/job-repository';
import { createProviderRegistry } from '../../src/lib/studio/providers/registry';
import { InlineJobQueue } from '../../src/lib/studio/queue/enqueue';
import { randomBytes } from 'node:crypto';
import type { AuditEntry } from '../../src/lib/audit';
import { createLocalKeyProvider } from '../../src/lib/studio/crypto/envelope';
import type { MetaCredentialSource } from '../../src/lib/studio/platforms/meta';
import type { OAuthClient } from '../../src/lib/studio/platforms/oauth';
import type { EngagementClient } from '../../src/lib/studio/platforms/publishing';
import { fakePublisherRegistry } from './fake-publishers';
import { memoryStorage } from './memory-storage';
import { ScriptedAdapter } from './scripted-adapter';

// Wires the real pipeline (real Postgres via Prisma, real router/tracking/kill switch/budget)
// to scripted provider doubles, in-memory storage, a fake media inspector and an inline queue.

export const IDEATION_JSON = {
  actionable: true,
  directionOptions: [],
  hook: 'Still buying supermarket bread?',
  keyMessage: 'Fresh sourdough delivered weekly',
  targetAudience: 'Leeds professionals 25–40',
  tone: 'warm, confident',
  callToAction: 'Subscribe today',
  keywords: ['sourdough', 'Leeds'],
  restrictedTopicsMentioned: [],
};

export const SCRIPT_JSON = {
  fullText: 'Still buying supermarket bread? Our sourdough is baked at dawn. Subscribe today.',
  shots: [
    {
      durationSec: 6,
      visualTreatment: 'AI_CLIP',
      sceneDescription: 'Golden loaf on a counter',
      cameraDirection: 'slow push-in',
      voiceoverText: 'Still buying supermarket bread?',
      onScreenText: 'Still buying supermarket bread?',
      transitionOut: 'fade',
    },
    {
      durationSec: 6,
      visualTreatment: 'AI_CLIP',
      sceneDescription: 'Baker scoring dough at dawn',
      cameraDirection: 'handheld',
      voiceoverText: 'Our sourdough is baked at dawn.',
      onScreenText: '',
      transitionOut: 'cut',
    },
    {
      durationSec: 3,
      visualTreatment: 'TEXT_CARD',
      sceneDescription: 'End card',
      cameraDirection: '',
      voiceoverText: 'Subscribe today.',
      onScreenText: 'Subscribe today',
      transitionOut: 'cut',
    },
  ],
};

export const SAFETY_ALLOW = { verdict: 'ALLOW', categories: [], reason: 'ordinary marketing' };

function textResult(json: unknown): ProviderPollResult {
  return {
    state: 'succeeded',
    output: { metadata: { model: 'scripted-claude', json, costPence: 1 } },
  };
}

export interface HarnessOptions {
  ideation?: unknown;
  script?: unknown;
  safety?: unknown;
  runwayRespond?: (request: ProviderRequest) => ProviderPollResult;
  probe?: Partial<MediaProbe>;
  loudness?: number | null;
  hiveMaxScores?: Record<string, number>;
}

export function createHarness(db: PrismaClient, options: HarnessOptions = {}) {
  const anthropic = new ScriptedAdapter('anthropic', ['text_generation'], (request) => {
    if (request.capability !== 'text_generation') throw new Error('unexpected');
    if (request.system.includes('ideation layer'))
      return textResult(options.ideation ?? IDEATION_JSON);
    if (request.system.includes('script and storyboard'))
      return textResult(options.script ?? SCRIPT_JSON);
    return textResult(options.safety ?? SAFETY_ALLOW);
  });
  const runway = new ScriptedAdapter(
    'runway',
    ['text_to_video', 'image_to_video'],
    options.runwayRespond ??
      (() => ({
        state: 'succeeded',
        output: { url: 'https://runway.invalid/clip.mp4', metadata: { costPence: 45 } },
      })),
    45,
  );
  runway.pollsBeforeDone = 1;
  const elevenlabs = new ScriptedAdapter('elevenlabs', ['tts'], (request) => ({
    state: 'succeeded',
    output: {
      url: 'https://signed.invalid/voice.mp3',
      metadata: {
        s3Bucket: 'assets',
        s3Key: `orgs/x/voice-${(request as { shotId?: string }).shotId}.mp3`,
        costPence: 1,
      },
    },
  }));
  const shotstack = new ScriptedAdapter(
    'shotstack',
    ['composition'],
    () => ({
      state: 'succeeded',
      output: {
        url: 'https://shotstack.invalid/render.mp4',
        metadata: { renderId: `render-${randomUUID()}` },
      },
    }),
    30,
  );
  const hive = new ScriptedAdapter('hive', ['content_safety'], () => ({
    state: 'succeeded',
    output: {
      metadata: {
        framesAnalysed: 15,
        maxScores: options.hiveMaxScores ?? { general_nsfw: 0.01 },
        flaggedFrames: [],
        costPence: 1,
      },
    },
  }));

  const { storage, objects } = memoryStorage();
  const breaker = createCircuitBreaker();
  const killSwitch = createKillSwitch({ store: createPrismaFlagStore(db), ttlMs: 0 });
  const queue = new InlineJobQueue();
  const probeResult: MediaProbe = {
    durationSec: 15,
    width: 1080,
    height: 1920,
    fps: 30,
    videoCodec: 'h264',
    videoProfile: 'High',
    audioCodec: 'aac',
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    bitRateKbps: 4500,
    ...options.probe,
  };
  const media: MediaInspector = {
    probe: vi.fn(async () => probeResult),
    blackIntervals: vi.fn(async () => []),
    integratedLoudness: vi.fn(async () =>
      options.loudness === undefined ? -14 : options.loudness,
    ),
  };
  const fetchImpl = vi.fn(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } }),
  );

  const publishers = fakePublisherRegistry();
  const keys = createLocalKeyProvider(randomBytes(32).toString('base64'), 'test');
  const audits: AuditEntry[] = [];
  const attributions: Array<Parameters<EngagementClient['attributePublication']>[0]> = [];
  const oauthClients = new Map<string, OAuthClient>();
  const meta: MetaCredentialSource = {
    getCredentials: vi.fn(async ({ platformAccountId }) => ({
      accessToken: 'meta-token',
      accountId: platformAccountId,
    })),
  };
  const deps: PipelineDeps = {
    db,
    registry: createProviderRegistry([anthropic, runway, elevenlabs, shotstack, hive]),
    breaker,
    killSwitch,
    budget: createPrismaBudgetChecker(db),
    tracking: { repo: createPrismaProviderJobRepository(db), killSwitch, breaker },
    queue,
    storage,
    media,
    logger: pino({ level: 'silent' }),
    config: {
      assetsBucket: 'assets',
      rendersBucket: 'renders',
      defaultVoiceId: 'voice-default',
      providerPollIntervalMs: 0,
      providerTimeoutMs: 60_000,
    },
    fetch: fetchImpl as unknown as typeof fetch,
    audit: (entry) => audits.push(entry),
    publishing: {
      db,
      publishers,
      meta,
      keys,
      oauth: (platform) => {
        const client = oauthClients.get(platform);
        if (!client) throw new Error(`no fake oauth client for ${platform}`);
        return client;
      },
      storage,
      engagement: { attributePublication: async (body) => void attributions.push(body) },
      logger: pino({ level: 'silent' }),
      now: Date.now,
    },
    now: Date.now,
    sleep: async () => undefined,
  };
  return {
    deps,
    queue,
    publishers,
    keys,
    audits,
    attributions,
    oauthClients,
    meta,
    adapters: { anthropic, runway, elevenlabs, shotstack, hive },
    objects,
    media,
    fetchImpl,
  };
}

export async function createProject(
  db: PrismaClient,
  overrides: { organisationId: string; description?: string; costBudgetPence?: number | null },
) {
  const runId = randomUUID();
  const project = await db.videoProject.create({
    data: {
      organisationId: overrides.organisationId,
      businessId: 'biz-1',
      createdByUserId: 'user-1',
      name: 'Leeds Sourdough Co',
      description: overrides.description ?? 'Launch video for our sourdough subscription',
      state: 'QUEUED',
      sourceType: 'BRIEF',
      targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 15 }],
      costBudgetPence: overrides.costBudgetPence ?? null,
      metadata: { runId },
    },
  });
  return { project, runId };
}
