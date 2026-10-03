import { ProviderError } from '../../errors';
import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderPollResult,
  ProviderRequest,
  ProviderSubmitResult,
} from '../providers/interface';
import { createProviderRegistry, type ProviderRegistry } from '../providers/registry';
import type { AssetStorage } from '../storage';

// 20.29 load-test harness — SIMULATED providers. They implement the real adapter contract, so the
// router, provider_jobs tracking, cost reservations, circuit breakers, 15.C3 rate windows, 20.29
// concurrency caps and BullMQ retries all run for real; only the remote call is replaced. Every
// job id starts "sim_" so a simulated result can never be mistaken for a provider's.
//
// Behaviour copied from the real providers (numbers: operator 2026-10-03 and the adapters' notes):
//   - latency: AI clips 30–180 s, composition 20–60 s, voice/text a few seconds (scaled by
//     timeScale so CI can run a burst in minutes; the report scales times back);
//   - account concurrency: Seedance 3 (individual BytePlus account), Kling 20 per pack, Veo
//     simulated at 10; a submit over the cap answers rate_limited (HTTP 429 / Kling 1303);
//   - a background share of random 429s (rateLimitedRatio) and of failed generations (failRatio).
// Outputs are small sample files (sample-media.ts) served from the harness's local storage.

export interface SimulationProfile {
  /** Multiply every simulated latency (1 = real time, 0.1 = ten times faster). */
  timeScale: number;
  /** Share of submits answered with a 429 regardless of load (0–1). */
  rateLimitedRatio: number;
  /** Share of generations that fail after running (0–1, retryable). */
  failRatio: number;
  /** In-flight cap per provider account (a submit over it is rate_limited). */
  accountConcurrency: Readonly<Record<string, number>>;
  random: () => number;
  now: () => number;
}

export const DEFAULT_ACCOUNT_CONCURRENCY: Readonly<Record<string, number>> = {
  seedance: 3,
  kling: 20,
  veo: 10,
};

interface SimJob {
  readyAt: number;
  organisationId: string;
  result: ProviderPollResult;
}

/** Peak in-flight counts, overall and per organisation (fairness / cap evidence). */
export interface InFlightStats {
  current: number;
  peak: number;
  peakByOrganisation: Record<string, number>;
  submitted: number;
  rateLimited: number;
  failed: number;
}

type Responder = (request: ProviderRequest) => Promise<ProviderPollResult>;

export class SimulatedAdapter implements ProviderAdapter {
  private readonly jobs = new Map<string, SimJob>();
  private readonly inFlightByOrg = new Map<string, number>();
  private seq = 0;
  readonly stats: InFlightStats = {
    current: 0,
    peak: 0,
    peakByOrganisation: {},
    submitted: 0,
    rateLimited: 0,
    failed: 0,
  };

  constructor(
    readonly providerId: string,
    readonly capabilities: readonly ProviderCapability[],
    private readonly options: {
      latencySec: readonly [number, number];
      costPence: number;
      respond: Responder;
      profile: SimulationProfile;
      /** Long generations get the background 429s and failures; quick calls do not. */
      flaky?: boolean;
    },
  ) {}

  get typicalLatencySec(): number {
    const [min, max] = this.options.latencySec;
    return ((min + max) / 2) * this.options.profile.timeScale;
  }

  estimateCostPence(): number {
    return this.options.costPence;
  }

  private rateLimited(message: string): ProviderError {
    this.stats.rateLimited += 1;
    return new ProviderError(this.providerId, 'rate_limited', message, true, { simulated: true });
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    const { profile, flaky } = this.options;
    const cap = profile.accountConcurrency[this.providerId];
    if (cap !== undefined && this.stats.current >= cap) {
      throw this.rateLimited(`simulated: over the account's ${cap} concurrent tasks`);
    }
    if (flaky && profile.random() < profile.rateLimitedRatio) {
      throw this.rateLimited('simulated: 429 Too Many Requests');
    }
    const [min, max] = this.options.latencySec;
    const latencyMs = (min + profile.random() * (max - min)) * 1000 * profile.timeScale;
    const willFail = Boolean(flaky) && profile.random() < profile.failRatio;
    const result: ProviderPollResult = willFail
      ? {
          state: 'failed',
          error: { class: 'unknown', message: 'simulated failure', retryable: true },
        }
      : await this.options.respond(request);
    this.seq += 1;
    const id = `sim_${this.providerId}_${this.seq}`;
    this.jobs.set(id, {
      readyAt: profile.now() + latencyMs,
      organisationId: request.organisationId,
      result,
    });
    this.track(request.organisationId, +1);
    this.stats.submitted += 1;
    return {
      providerJobId: id,
      estimatedCostPence: this.options.costPence,
      estimatedReadyAt: new Date(profile.now() + latencyMs),
    };
  }

  private track(organisationId: string, delta: 1 | -1): void {
    this.stats.current += delta;
    this.stats.peak = Math.max(this.stats.peak, this.stats.current);
    const org = (this.inFlightByOrg.get(organisationId) ?? 0) + delta;
    this.inFlightByOrg.set(organisationId, org);
    this.stats.peakByOrganisation[organisationId] = Math.max(
      this.stats.peakByOrganisation[organisationId] ?? 0,
      org,
    );
  }

  async poll(providerJobId: string): Promise<ProviderPollResult> {
    const job = this.jobs.get(providerJobId);
    if (!job) {
      return {
        state: 'failed',
        error: { class: 'result_expired', message: 'simulated: unknown job', retryable: true },
      };
    }
    if (this.options.profile.now() < job.readyAt) return { state: 'running' };
    this.finish(providerJobId, job);
    if (job.result.state === 'failed') this.stats.failed += 1;
    return job.result;
  }

  private finish(id: string, job: SimJob): void {
    if (!this.jobs.delete(id)) return;
    this.track(job.organisationId, -1);
  }

  async cancel(providerJobId: string): Promise<void> {
    const job = this.jobs.get(providerJobId);
    if (job) this.finish(providerJobId, job);
  }

  async healthCheck() {
    return { healthy: true };
  }
}

// ---- Scripted answers for the text layers (the shapes the pipeline's schemas accept) ----------

export const SIM_IDEATION = {
  actionable: true,
  directionOptions: [],
  hook: 'Still buying supermarket bread?',
  keyMessage: 'Fresh sourdough delivered weekly',
  targetAudience: 'Busy professionals 25–40',
  tone: 'warm, confident',
  callToAction: 'Subscribe today',
  keywords: ['sourdough', 'bakery'],
  restrictedTopicsMentioned: [],
};

/** A 30 s short: 4 AI clips (the STANDARD budget, 20.25), 2 stills and an end card. */
export const SIM_SCRIPT = {
  fullText:
    'Still buying supermarket bread? Our sourdough is baked at dawn. Slow fermented for flavour. Delivered to your door. Fresh every week. Subscribe today.',
  shots: [
    ['AI_CLIP', 4, 'hook', 'Golden loaf on a counter', 'Still buying supermarket bread?'],
    ['AI_CLIP', 4, 'demo', 'Baker scoring dough at dawn', 'Our sourdough is baked at dawn.'],
    ['AI_CLIP', 4, 'other', 'Dough rising in baskets', 'Slow fermented for flavour.'],
    ['IMAGE_STILL', 5, 'other', 'Bread box on a doorstep', 'Delivered to your door.'],
    ['IMAGE_STILL', 5, 'other', 'Sliced loaf on a board', 'Fresh every week.'],
    ['AI_CLIP', 4, 'cta', 'Hands holding a warm loaf', 'Subscribe today.'],
    ['TEXT_CARD', 4, 'cta', 'End card', ''],
  ].map(([visualTreatment, durationSec, beat, sceneDescription, voiceoverText]) => ({
    durationSec,
    visualTreatment,
    beat,
    sceneDescription,
    cameraDirection: 'slow push-in',
    voiceoverText,
    onScreenText: visualTreatment === 'TEXT_CARD' ? 'Subscribe today' : '',
    transitionOut: 'cut',
  })),
};

function textResult(json: unknown): ProviderPollResult {
  return { state: 'succeeded', output: { metadata: { model: 'simulated', json, costPence: 1 } } };
}

/** The answer for a text_generation request, chosen by its system prompt. */
export function simulatedText(request: ProviderRequest): ProviderPollResult {
  if (request.capability !== 'text_generation') throw new Error('not a text request');
  if (request.system.includes('ideation layer')) return textResult(SIM_IDEATION);
  if (request.system.includes('script and storyboard')) return textResult(SIM_SCRIPT);
  if (request.system.includes('social-media slideshow')) {
    return textResult({
      hook: '5 reasons people love our sourdough',
      cta: 'Order today',
      items: ['48-hour ferment', 'Baked at dawn', 'Local flour', 'Crackling crust', 'Weekly'],
    });
  }
  return textResult({ verdict: 'ALLOW', categories: [], reason: 'simulated' });
}

// ---- The registry ------------------------------------------------------------------------------

export interface SampleMediaUrls {
  clipUrl: string;
  renderUrl: string;
  voice: Uint8Array;
  music: Uint8Array;
  png: Uint8Array;
}

/** One small deterministic embedding (1536 numbers) per text. */
export function simulatedEmbedding(text: string): number[] {
  let seed = 0;
  for (const ch of text) seed = (seed * 31 + ch.charCodeAt(0)) % 9_973;
  return Array.from({ length: 1536 }, (_, i) => Math.sin(seed + i) / 40);
}

export function createSimulatedRegistry(input: {
  profile: SimulationProfile;
  media: SampleMediaUrls;
  storage: AssetStorage;
  assetsBucket: string;
}): { registry: ProviderRegistry; adapters: SimulatedAdapter[] } {
  const { profile, media, storage, assetsBucket } = input;
  let stored = 0;
  const store = async (
    organisationId: string,
    body: Uint8Array,
    extension: string,
    contentType: string,
    costPence: number,
  ): Promise<ProviderPollResult> => {
    stored += 1;
    const put = await storage.put({
      bucket: assetsBucket,
      key: `orgs/${organisationId}/simulated/${Date.now()}-${stored}.${extension}`,
      body,
      contentType,
    });
    return {
      state: 'succeeded',
      output: {
        url: put.url,
        metadata: { s3Bucket: put.bucket, s3Key: put.key, model: 'simulated', costPence },
      },
    };
  };
  const video = (id: string, costPence: number) =>
    new SimulatedAdapter(id, ['text_to_video', 'image_to_video'], {
      latencySec: [30, 180],
      costPence,
      respond: async () => ({
        state: 'succeeded',
        output: { url: media.clipUrl, metadata: { model: id, costPence } },
      }),
      profile,
      flaky: true,
    });
  const adapters = [
    new SimulatedAdapter('anthropic', ['text_generation'], {
      latencySec: [2, 8],
      costPence: 1,
      respond: async (r) => simulatedText(r),
      profile,
    }),
    // 20.25 per-clip costs (a 4 s clip): Seedance 2.0 mini 720p ~19p, Kling ~30p, Veo Fast ~33p.
    video('seedance', 19),
    video('kling', 30),
    video('veo', 33),
    new SimulatedAdapter('elevenlabs', ['tts'], {
      latencySec: [1, 4],
      costPence: 1,
      respond: async (r) => store(r.organisationId, media.voice, 'mp3', 'audio/mpeg', 1),
      profile,
    }),
    new SimulatedAdapter('elevenlabs-music', ['music'], {
      latencySec: [10, 40],
      costPence: 5,
      respond: async (r) => store(r.organisationId, media.music, 'mp3', 'audio/mpeg', 5),
      profile,
    }),
    new SimulatedAdapter('assemblyai', ['transcription'], {
      latencySec: [2, 10],
      costPence: 1,
      respond: async () => ({
        state: 'succeeded',
        output: {
          metadata: {
            text: 'Still buying supermarket bread?',
            words: [
              { text: 'Still', startSec: 0.1, endSec: 0.4 },
              { text: 'buying', startSec: 0.4, endSec: 0.8 },
            ],
            costPence: 1,
          },
        },
      }),
      profile,
    }),
    new SimulatedAdapter('openai', ['embedding', 'text_to_image'], {
      latencySec: [1, 12],
      costPence: 4,
      respond: async (r) =>
        r.capability === 'embedding'
          ? {
              state: 'succeeded',
              output: {
                metadata: { embeddings: r.input.map(simulatedEmbedding), costPence: 1 },
              },
            }
          : store(r.organisationId, media.png, 'png', 'image/png', 4),
      profile,
    }),
    // Shotstack at its list price: $0.30 a rendered minute, ~12p for a 30 s short (20.25).
    new SimulatedAdapter('shotstack', ['composition'], {
      latencySec: [20, 60],
      costPence: 12,
      respond: async () => ({
        state: 'succeeded',
        output: { url: media.renderUrl, metadata: { renderId: 'simulated', costPence: 12 } },
      }),
      profile,
      flaky: true,
    }),
  ];
  return { registry: createProviderRegistry(adapters), adapters };
}
