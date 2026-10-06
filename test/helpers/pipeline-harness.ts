import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import pino from 'pino';
import { vi } from 'vitest';
import {
  createKillSwitch,
  createPrismaFlagStore,
  type FlagStore,
} from '../../src/lib/studio/kill-switch';
import { flagKeys } from '../../src/lib/studio/system-flags';
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
import type { MetricsRegistry } from '../../src/lib/studio/analytics/fetchers';
import type { StockImageSource } from '../../src/lib/studio/images/stock';
import type { PageRenderer } from '../../src/lib/studio/scan/crawl';
import { fakePublisherRegistry } from './fake-publishers';
import { memoryStorage } from './memory-storage';
import { fakeEmbedding, fakePng } from './png';
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

export const SLIDESHOW_TEXT_JSON = {
  hook: '5 reasons Leeds loves our sourdough',
  cta: 'Order your first loaf today',
  items: [
    'Slow 48-hour ferment',
    'Baked at dawn',
    'Local organic flour',
    'Crackling crust',
    'Delivered weekly',
  ],
};

export const ANALYSIS_JSON = {
  title: 'Bakery morning routine',
  description: 'A baker shows the dawn bake, ending on a subscribe card.',
  tags: ['bakery', 'Behind the scenes', 'bakery'],
  categorySlugs: ['community/behind-the-scenes/production', 'lifestyle/food/baking'],
  hookPattern: 'bold question on screen',
  structurePattern: 'hook-process-cta',
  ctaPattern: 'subscribe card',
  paceTag: 'fast-cut',
  moodTag: 'upbeat-confident',
  genreTag: 'behind-the-scenes',
  musicMoodTag: 'lofi-hip-hop',
  shots: [
    {
      type: 'HOOK_TEXT_ON_STILL',
      description: 'loaf close-up',
      onScreenText: 'Ever wondered?',
      overlayStyle: 'bold-centre',
      voiceoverPresent: true,
    },
    {
      type: 'B_ROLL',
      description: 'baker shaping dough',
      onScreenText: '',
      overlayStyle: 'subtitle-lower',
      voiceoverPresent: true,
    },
    {
      type: 'CTA_CARD',
      description: 'subscribe card',
      onScreenText: 'Subscribe',
      overlayStyle: 'bold-bottom',
      voiceoverPresent: false,
    },
  ],
};

export const PROFILE_JSON = {
  industry: 'Food and drink — bakery',
  subNiche: 'artisan sourdough subscriptions',
  products: ['sourdough loaves', 'bread subscription'],
  services: ['weekly delivery'],
  audienceKeywords: ['Leeds professionals'],
  toneIndicators: ['warm', 'crafted'],
  regions: ['UK'],
  imageThemes: ['bread', 'bakery', 'dough'],
  searchQueries: ['sourdough bread', 'artisan bakery'],
  restrictedTopics: [],
  brandVoiceSummary: 'Warm and proud of the craft.',
  /** 15.D8 / A13: the classifier's self-reported confidence (≥ 0.7: not flagged for review). */
  confidence: 0.92,
};

/**
 * 20.9: a scripted month plan — one post per slot line of the prompt ("n. <date> — <kind> — angle:
 * <angle>"), so a draft of any size gets exactly the posts it asked for.
 */
export function monthPlanJson(prompt: string) {
  const count = Number(/Write exactly (\d+) posts/.exec(prompt)?.[1] ?? 0);
  const lines = prompt.split('\n');
  return {
    items: Array.from({ length: count }, (_, i) => {
      const line = lines.find((l) => l.startsWith(`${i + 1}. `)) ?? '';
      const [date = '', , angle = ''] = line.slice(`${i + 1}. `.length).split(' — ');
      return {
        index: i + 1,
        title: `${angle.replace('angle: ', '')} for ${date}`.slice(0, 80),
        brief: `A short post about our sourdough for ${date}.`,
        hook: 'Fresh from the oven',
        points: ['Baked at dawn', 'Local flour', 'Delivered weekly'],
        cta: 'Order today',
      };
    }),
  };
}

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
  profile?: unknown;
  metrics?: MetricsRegistry;
  analysis?: unknown;
  /** Omit the scripted AssemblyAI adapter (no transcription provider configured). */
  noTranscription?: boolean;
  /** 20.22: the words the scripted AssemblyAI returns for every narration (default: one word). */
  transcriptWords?: Array<{ text: string; startSec: number; endSec: number }>;
  sceneChanges?: number[];
  slideshowText?: unknown;
  /** 20.9: the month plan answer (default: monthPlanJson of the prompt). */
  monthPlan?: unknown;
  /** Feature D: fetch used for website pages and images (defaults to the media fetch mock). */
  pageFetch?: typeof fetch;
  renderer?: PageRenderer;
  stockSources?: StockImageSource[];
  /** 21.4: register a scripted Veo that makes UGC actor clips (actor_video). */
  actor?: boolean;
  /** 21.4: the scripted Veo actor's answer (default: a clip). */
  actorRespond?: (request: ProviderRequest) => ProviderPollResult;
  /** 21.4a: the scripted OpenAI image answer (default, or when it returns null: a stored PNG). */
  imageRespond?: (request: ProviderRequest) => ProviderPollResult | null;
  /** 22.1: the hook line answer; 22.2: the wall-of-text answer. */
  hookLine?: unknown;
  wallText?: unknown;
  /** 22.2: register a scripted stock-footage adapter (Pexels video). */
  stock?: boolean;
}

export function createHarness(db: PrismaClient, options: HarnessOptions = {}) {
  const anthropic = new ScriptedAdapter('anthropic', ['text_generation'], (request) => {
    if (request.capability !== 'text_generation') throw new Error('unexpected');
    if (request.system.includes('ideation layer'))
      return textResult(options.ideation ?? IDEATION_JSON);
    if (request.system.includes('script and storyboard'))
      return textResult(options.script ?? SCRIPT_JSON);
    if (request.system.includes('social-media slideshow'))
      return textResult(options.slideshowText ?? SLIDESHOW_TEXT_JSON);
    if (request.system.includes('analyse short-form marketing videos'))
      return textResult(options.analysis ?? ANALYSIS_JSON);
    if (request.system.includes('business-classification'))
      return textResult(options.profile ?? PROFILE_JSON);
    if (request.system.includes('month content planner'))
      return textResult(options.monthPlan ?? monthPlanJson(request.prompt));
    // 22.1 / 22.2: a hook + demo video's hook line and a wall of text's block.
    if (request.system.includes('ONE line of on-screen text'))
      return textResult(
        options.hookLine ?? { hookLine: 'Still taking bookings by phone?', framework: 'question' },
      );
    if (request.system.includes('"wall of text"'))
      return textResult(
        options.wallText ?? { text: 'Three habits\n- Plan tomorrow tonight\n- Batch errands' },
      );
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
  // 21.4: a scripted Veo for UGC actor clips (the clip's own audio is the narration).
  const veo = new ScriptedAdapter(
    'veo',
    ['actor_video'],
    options.actorRespond ??
      (() => ({
        state: 'succeeded',
        output: {
          url: 'https://veo.invalid/actor.mp4',
          metadata: { audio: 'native', costPence: 45 },
        },
      })),
    45,
  );
  // 22.2: scripted stock footage (a wall of text's background).
  const stockVideo = new ScriptedAdapter('pexels-video', ['stock_footage'], () => ({
    state: 'succeeded',
    output: {
      url: 'https://pexels.invalid/calm.mp4',
      metadata: { licence: 'Pexels', costPence: 0 },
    },
  }));
  // 20.21: no content-safety adapter (Hive removed; none is built), as in production.

  const { storage, objects } = memoryStorage();
  const assemblyai = new ScriptedAdapter('assemblyai', ['transcription'], () => ({
    state: 'succeeded',
    output: {
      metadata: {
        text: 'Ever wondered how our bread is made? Subscribe for more.',
        words: options.transcriptWords ?? [{ text: 'Ever', startSec: 0.1, endSec: 0.4 }],
        costPence: 1,
      },
    },
  }));
  let generated = 0;
  const openai = new ScriptedAdapter('openai', ['embedding', 'text_to_image'], async (request) => {
    if (request.capability === 'embedding') {
      return {
        state: 'succeeded',
        output: {
          metadata: { embeddings: request.input.map((t) => fakeEmbedding(t)), costPence: 1 },
        },
      };
    }
    if (request.capability !== 'text_to_image') throw new Error('unexpected');
    const scripted = options.imageRespond?.(request) ?? null;
    if (scripted) return scripted;
    generated += 1;
    const stored = await storage.put({
      bucket: 'assets',
      key: `orgs/${request.organisationId}/generated-${generated}.png`,
      body: fakePng(1024, 1024, 9_000 + generated),
      contentType: 'image/png',
    });
    return {
      state: 'succeeded',
      output: {
        url: stored.url,
        metadata: {
          s3Bucket: stored.bucket,
          s3Key: stored.key,
          model: 'scripted-image',
          costPence: 4,
        },
      },
    };
  });
  const breaker = createCircuitBreaker();
  // The GLOBAL flag is one row shared by every test file on this database, and
  // test/api/kill-switch-admin.test.ts flips it for real. Journeys here run concurrently in other
  // files, so they ignore it (as if it were off); workspace/project/provider/platform flags are
  // keyed by each journey's own ids and stay real. Global behaviour: kill-switch.test.ts +
  // test/integration/kill-switch.test.ts.
  const prismaFlags = createPrismaFlagStore(db);
  const flagStore: FlagStore = {
    getFlags: (keys) => prismaFlags.getFlags(keys.filter((k) => k !== flagKeys.global())),
  };
  const killSwitch = createKillSwitch({ store: flagStore, ttlMs: 0 });
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
    sceneChanges: vi.fn(async () => options.sceneChanges ?? [2.5, 6]),
    frameJpeg: vi.fn(async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9])),
    previewClip: vi.fn(async () => new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])),
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
    registry: createProviderRegistry([
      anthropic,
      runway,
      elevenlabs,
      shotstack,
      openai,
      ...(options.noTranscription ? [] : [assemblyai]),
      ...(options.actor ? [veo] : []),
      ...(options.stock ? [stockVideo] : []),
    ]),
    breaker,
    killSwitch,
    budget: createPrismaBudgetChecker(db),
    tracking: { repo: createPrismaProviderJobRepository(db), killSwitch, breaker },
    queue,
    storage,
    media,
    // 15.A3: a JPEG-magic stand-in for FFmpeg thumbnail rendering.
    thumbnails: { compose: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]) },
    logger: pino({ level: 'silent' }),
    config: {
      assetsBucket: 'assets',
      rendersBucket: 'renders',
      defaultVoiceId: 'voice-default',
      providerPollIntervalMs: 0,
      providerTimeoutMs: 60_000,
      fontsBaseUrl: 'https://fonts.test',
      libraryBucket: 'library',
    },
    fetch: fetchImpl as unknown as typeof fetch,
    audit: (entry) => audits.push(entry),
    metrics: options.metrics ?? {},
    scan: {
      pageFetch: options.pageFetch ?? (fetchImpl as unknown as typeof fetch),
      renderer: options.renderer,
      stock: () => ({ primary: options.stockSources ?? [], fallback: [] }),
      random: () => 0,
    },
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
      thumbnailsBucket: 'thumbnails',
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
    adapters: { anthropic, runway, elevenlabs, shotstack, openai, assemblyai, veo, stockVideo },
    objects,
    media,
    fetchImpl,
  };
}

export async function createProject(
  db: PrismaClient,
  overrides: {
    organisationId: string;
    description?: string;
    costBudgetPence?: number | null;
    /** 21.4: extra project metadata (e.g. the UGC style). */
    metadata?: Record<string, unknown>;
    /** 21.4a: the TikTok format's length (default 15 s). */
    durationSec?: number;
    /** 22.1 / 22.2: another source type (default BRIEF). */
    sourceType?: 'BRIEF' | 'HOOK_DEMO' | 'WALL_OF_TEXT';
    /** 22.1: target formats (default one TikTok format). */
    targetFormats?: Array<{ platform: string; aspectRatio: string; duration: number }>;
  },
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
      sourceType: overrides.sourceType ?? 'BRIEF',
      targetFormats: overrides.targetFormats ?? [
        { platform: 'tiktok', aspectRatio: '9:16', duration: overrides.durationSec ?? 15 },
      ],
      costBudgetPence: overrides.costBudgetPence ?? null,
      metadata: { ...overrides.metadata, runId } as Prisma.InputJsonObject,
    },
  });
  return { project, runId };
}
