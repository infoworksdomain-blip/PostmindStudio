import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import {
  inspireSupplement,
  templateConstraint,
  type Blueprint,
} from '../../src/lib/studio/library/blueprint';
import { EMBEDDING_DIMENSIONS } from '../../src/lib/studio/library/search';
import { IDEATION_SYSTEM_PROMPT } from '../../src/lib/studio/pipeline/ideation';
import { SCRIPT_SAFETY_SYSTEM_PROMPT } from '../../src/lib/studio/pipeline/script-safety';
import { SCRIPT_SYSTEM_PROMPT } from '../../src/lib/studio/pipeline/scripting';
import { AnthropicAdapter } from '../../src/lib/studio/providers/anthropic';
import { AssemblyAiAdapter } from '../../src/lib/studio/providers/assemblyai';
import { ElevenLabsAdapter } from '../../src/lib/studio/providers/elevenlabs';
import { ElevenLabsMusicAdapter } from '../../src/lib/studio/providers/elevenlabs-music';
import type { ProviderAdapter, ProviderRequest } from '../../src/lib/studio/providers/interface';
import { OpenAIAdapter } from '../../src/lib/studio/providers/openai';
import { RunwayAdapter } from '../../src/lib/studio/providers/runway';
import { SeedanceAdapter } from '../../src/lib/studio/providers/seedance';
import { typicalVideoCalls, typicalVideoPlan } from '../../src/lib/studio/cost/video-estimate';
import { ShotstackAdapter } from '../../src/lib/studio/providers/shotstack';
import type { TextTask } from '../../src/lib/studio/providers/text-tasks';
import {
  POST_COPY_MAX_TOKENS,
  SYSTEM_PROMPT as CAPTION_SYSTEM_PROMPT,
} from '../../src/lib/studio/services/caption-suggestions';
import { StoryblocksAudioAdapter } from '../../src/lib/studio/providers/storyblocks-audio';
import { memoryStorage } from '../helpers/memory-storage';

// BACKLOG 13.31 — the golden journeys (test/golden) as the provider requests they make, priced
// with the adapters' own cost estimators (the price tables Studio uses for budget checks and
// reservations). A weekly CI run compares the totals with cost-baseline.json: a change to a
// price table, a model default, or the requests a journey makes shows up as drift.
//
// Everything here is offline: the SDK clients are constructed but never called.

/** Fixed so the baseline only moves when prices or requests change (the live rate is env). */
export const HARNESS_USD_TO_GBP = 0.79;
const ORG = 'org_cost';
const PROJECT = 'prj_cost';
/** Representative Layer 1/2 user-prompt size (brief, brand, format lines). */
const USER_PROMPT_CHARS = 1_200;
// plan-project.ts IDEATION_MAX_TOKENS / SCRIPT_MAX_TOKENS / SAFETY_MAX_TOKENS.
const IDEATION_MAX_TOKENS = 4_000;
const SCRIPT_MAX_TOKENS = 8_000;
const SAFETY_MAX_TOKENS = 1_000;

export function harnessAdapters(): Record<
  string,
  ProviderAdapter & { estimateCostPence(r: ProviderRequest): number }
> {
  const { storage } = memoryStorage();
  const rate = HARNESS_USD_TO_GBP;
  return {
    anthropic: new AnthropicAdapter({
      client: new Anthropic({ apiKey: 'cost-regression-offline' }),
      usdToGbpRate: rate,
    }),
    openai: new OpenAIAdapter({
      client: new OpenAI({ apiKey: 'cost-regression-offline' }),
      storage,
      bucket: 'assets',
      usdToGbpRate: rate,
    }),
    runway: new RunwayAdapter({ apiKey: 'offline', usdToGbpRate: rate }),
    seedance: new SeedanceAdapter({ apiKey: 'offline', usdToGbpRate: rate }),
    elevenlabs: new ElevenLabsAdapter({
      apiKey: 'offline',
      storage,
      bucket: 'assets',
      usdToGbpRate: rate,
    }),
    'elevenlabs-music': new ElevenLabsMusicAdapter({
      apiKey: 'offline',
      storage,
      bucket: 'assets',
      usdToGbpRate: rate,
    }),
    shotstack: new ShotstackAdapter({ apiKey: 'offline', environment: 'v1', usdToGbpRate: rate }),
    assemblyai: new AssemblyAiAdapter({ apiKey: 'offline', usdToGbpRate: rate }),
    'storyblocks-audio': new StoryblocksAudioAdapter({
      publicKey: 'offline',
      privateKey: 'offline',
      storage,
      bucket: 'assets',
    }),
  };
}

export interface PricedCall {
  providerId: string;
  request: ProviderRequest;
}

const base = { organisationId: ORG, projectId: PROJECT };
const userPrompt = 'x'.repeat(USER_PROMPT_CHARS);

/** 15.D10: Feature A reference supplements appended to the Layer 1 / Layer 2 prompts. */
interface PlanningSupplement {
  ideation?: string;
  script?: string;
}

function planning(formats: number, supplement: PlanningSupplement = {}): PricedCall[] {
  const text = (system: string, maxTokens: number, task: TextTask, extra?: string): PricedCall => ({
    providerId: 'anthropic',
    request: {
      ...base,
      capability: 'text_generation',
      task,
      system,
      prompt: extra
        ? `${userPrompt}

${extra}`
        : userPrompt,
      maxTokens,
    },
  });
  // 23.2: one safety check per script (light model) and the post copy (light model).
  return [
    text(IDEATION_SYSTEM_PROMPT, IDEATION_MAX_TOKENS, 'ideation', supplement.ideation),
    ...Array.from({ length: formats }, () =>
      text(SCRIPT_SYSTEM_PROMPT, SCRIPT_MAX_TOKENS, 'script', supplement.script),
    ),
    ...Array.from({ length: formats }, () =>
      text(SCRIPT_SAFETY_SYSTEM_PROMPT, SAFETY_MAX_TOKENS, 'script_safety'),
    ),
    text(CAPTION_SYSTEM_PROMPT, POST_COPY_MAX_TOKENS, 'post_copy'),
  ];
}

interface ShotSpec {
  treatment: 'AI_CLIP' | 'IMAGE_STILL' | 'TEXT_CARD';
  durationSec: number;
  narration: string;
  sfx?: boolean;
}

/** GP-01's script (test/helpers/pipeline-harness.ts SCRIPT_JSON). */
const GP01_SHOTS: ShotSpec[] = [
  { treatment: 'AI_CLIP', durationSec: 6, narration: 'Still buying supermarket bread?' },
  { treatment: 'AI_CLIP', durationSec: 6, narration: 'Our sourdough is baked at dawn.' },
  { treatment: 'TEXT_CARD', durationSec: 3, narration: 'Subscribe today.' },
];

function assets(shots: ShotSpec[]): PricedCall[] {
  return shots.flatMap((shot): PricedCall[] => {
    const calls: PricedCall[] = [];
    if (shot.treatment === 'AI_CLIP') {
      calls.push({
        providerId: 'runway',
        request: {
          ...base,
          capability: 'text_to_video',
          prompt: 'scene',
          durationSec: shot.durationSec,
          aspectRatio: '9:16',
        },
      });
    }
    if (shot.treatment === 'IMAGE_STILL') {
      calls.push({
        providerId: 'openai',
        request: { ...base, capability: 'text_to_image', prompt: 'scene', aspectRatio: '9:16' },
      });
    }
    calls.push({
      providerId: 'elevenlabs',
      request: { ...base, capability: 'tts', text: shot.narration, voiceId: 'voice' },
    });
    if (shot.sfx) {
      calls.push({
        providerId: 'storyblocks-audio',
        request: { ...base, capability: 'sfx', query: 'whoosh', maxDurationSec: 3 },
      });
    }
    return calls;
  });
}

function finishing(videoSec: number, formats: number, captions: boolean): PricedCall[] {
  const perFormat: PricedCall[] = [
    {
      providerId: 'shotstack',
      request: { ...base, capability: 'composition', edit: {}, outputDurationSec: videoSec },
    },
  ];
  if (captions) {
    perFormat.push({
      providerId: 'assemblyai',
      request: {
        ...base,
        capability: 'transcription',
        mediaUrl: 'https://x',
        durationSec: videoSec,
      },
    });
  }
  return [
    {
      providerId: 'elevenlabs-music',
      request: { ...base, capability: 'music', prompt: 'warm acoustic', durationSec: videoSec },
    },
    ...Array.from({ length: formats }, () => perFormat).flat(),
  ];
}

const sec = (shots: ShotSpec[]) => shots.reduce((s, x) => s + x.durationSec, 0);

/** A four-minute YouTube video: 24 ten-second shots, mostly AI clips, some stills. */
const LONG_FORM: ShotSpec[] = Array.from({ length: 24 }, (_, i) => ({
  treatment: i % 4 === 3 ? 'IMAGE_STILL' : 'AI_CLIP',
  durationSec: 10,
  narration: 'x'.repeat(62),
  sfx: i % 6 === 0,
}));

const SLIDESHOW: ShotSpec[] = Array.from({ length: 5 }, () => ({
  treatment: 'IMAGE_STILL',
  durationSec: 6,
  narration: '',
}));

/**
 * 15.D10 (A10 / A14.2): the spec 12.2 sample 30 s short as one output — three 10 s AI clips,
 * ~80 words of narration, a 30 s music bed, one composition + safety scan.
 */
const SHORT_30S: ShotSpec[] = Array.from({ length: 3 }, () => ({
  treatment: 'AI_CLIP',
  durationSec: 10,
  narration: 'x'.repeat(150),
}));

/** Feature A: the library search that picks the reference (one query embedding, search.ts). */
const LIBRARY_SEARCH: PricedCall = {
  providerId: 'openai',
  request: {
    ...base,
    capability: 'embedding',
    input: ['cosy bakery morning routine, warm and upbeat'],
    dimensions: EMBEDDING_DIMENSIONS,
  },
};

/** INSPIRE (A3.7): a style signature supplements Layers 1 and 2 (library/reference.ts). */
const INSPIRE_SUPPLEMENT = inspireSupplement({
  paceTag: 'fast',
  moodTag: 'warm, upbeat',
  structurePattern: 'hook → problem → product reveal → call to action',
  musicGenreTag: 'acoustic pop',
});

/** TEMPLATE (A3.6): a five-shot blueprint constrains each Layer 2 prompt. */
const TEMPLATE_BLUEPRINT: Blueprint = {
  shotCount: 5,
  totalDurationSec: 30,
  shots: [
    {
      durationSec: 3,
      type: 'HOOK_TEXT_ON_STILL',
      overlayStyle: 'bold-centre',
      voiceoverPresent: true,
      hasOnScreenText: true,
    },
    {
      durationSec: 8,
      type: 'AI_CLIP_ACTION',
      overlayStyle: 'none',
      voiceoverPresent: true,
      hasOnScreenText: false,
    },
    {
      durationSec: 8,
      type: 'PRODUCT_SHOT',
      overlayStyle: 'none',
      voiceoverPresent: true,
      hasOnScreenText: false,
    },
    {
      durationSec: 7,
      type: 'B_ROLL',
      overlayStyle: 'subtitle-lower',
      voiceoverPresent: true,
      hasOnScreenText: true,
    },
    {
      durationSec: 4,
      type: 'CTA_CARD',
      overlayStyle: 'caption-box',
      voiceoverPresent: true,
      hasOnScreenText: true,
    },
  ],
  musicEnvelope: { bpm: 110, energy: 'high', moodTag: 'upbeat' },
  transitionSequence: ['cut', 'cut', 'cut', 'cut', 'cut'],
  hookPattern: 'question to camera',
  structurePattern: 'hook → problem → product reveal → call to action',
  ctaPattern: 'visit the shop today',
  paceTag: 'fast',
};
const TEMPLATE_SUPPLEMENT = templateConstraint(TEMPLATE_BLUEPRINT, 30, [
  'AI_CLIP',
  'IMAGE_STILL',
  'TEXT_CARD',
]);

export const JOURNEYS: Record<string, PricedCall[]> = {
  // GP-01: brief → one 15 s TikTok.
  'gp01-short-single-format': [
    ...planning(1),
    ...assets(GP01_SHOTS),
    ...finishing(sec(GP01_SHOTS), 1, false),
  ],
  // GP-02: the same brief rendered for TikTok, Shorts and Reels.
  'gp02-short-three-formats': [
    ...planning(3),
    ...assets([...GP01_SHOTS, ...GP01_SHOTS, ...GP01_SHOTS]),
    ...finishing(sec(GP01_SHOTS), 3, true),
  ],
  // 13.25 long-form YouTube (async moderation) with sound effects.
  'long-form-youtube-4min': [
    ...planning(1),
    ...assets(LONG_FORM),
    ...finishing(sec(LONG_FORM), 1, true),
  ],
  // 15.D10: the A10 "per output" comparisons (standard short, INSPIRE, TEMPLATE; A14.2).
  'standard-30s-short': [...planning(1), ...assets(SHORT_30S), ...finishing(30, 1, false)],
  'inspire-30s-short': [
    LIBRARY_SEARCH,
    ...planning(1, { ideation: INSPIRE_SUPPLEMENT, script: INSPIRE_SUPPLEMENT }),
    ...assets(SHORT_30S),
    ...finishing(30, 1, false),
  ],
  'template-30s-short': [
    LIBRARY_SEARCH,
    ...planning(1, { script: TEMPLATE_SUPPLEMENT }),
    ...assets(SHORT_30S),
    ...finishing(30, 1, false),
  ],
  // 20.25: a typical 30 s short per tier under the AI clip budget (cost/video-estimate.ts).
  'budgeted-30s-short-basic': typicalVideoCalls(typicalVideoPlan('BASIC', 30)),
  'budgeted-30s-short-standard': typicalVideoCalls(typicalVideoPlan('STANDARD', 30)),
  'budgeted-30s-short-plus': typicalVideoCalls(typicalVideoPlan('PLUS', 30)),
  // Slideshow (A5): generated stills, no narration model calls beyond planning.
  'slideshow-five-slides': [
    ...planning(1),
    ...SLIDESHOW.map((): PricedCall => ({
      providerId: 'openai',
      request: { ...base, capability: 'text_to_image', prompt: 'slide', aspectRatio: '9:16' },
    })),
    ...finishing(sec(SLIDESHOW), 1, false),
  ],
};

export function journeyCosts(): Record<string, number> {
  const adapters = harnessAdapters();
  return Object.fromEntries(
    Object.entries(JOURNEYS).map(([name, calls]) => [
      name,
      calls.reduce((total, call) => {
        const adapter = adapters[call.providerId];
        if (!adapter) throw new Error(`No harness adapter for ${call.providerId}`);
        return total + adapter.estimateCostPence(call.request);
      }, 0),
    ]),
  );
}

/** Relative drift of each journey from the baseline; missing/extra journeys count as drift. */
export function costDrift(
  baseline: Record<string, number>,
  actual: Record<string, number>,
): Array<{ journey: string; baseline: number | null; actual: number | null; drift: number }> {
  const names = [...new Set([...Object.keys(baseline), ...Object.keys(actual)])].sort();
  return names.map((journey) => {
    const b = baseline[journey];
    const a = actual[journey];
    if (b === undefined || a === undefined)
      return { journey, baseline: b ?? null, actual: a ?? null, drift: Infinity };
    const drift = b === 0 ? (a === 0 ? 0 : Infinity) : Math.abs(a - b) / b;
    return { journey, baseline: b, actual: a, drift };
  });
}
