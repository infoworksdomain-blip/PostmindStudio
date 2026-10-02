import type { ProviderRequest } from '../../providers/interface';
import { PLATFORMS, type Platform } from '../../services/catalog';
import { storageRequiredEnv } from '../../storage-client';
import type { GateSection, Verdict } from './report';

// Phase 14.8 — the live provider and posting run (pure plan + cost estimate + verdicts).
// scripts/ops/staging-gate.ts --live-providers prints the plan and its cost estimate (from each
// adapter's own estimateCostPence) and refuses to spend anything without --confirm.
//
// Two kinds of provider test:
//   script   an existing GATE 2 smoke script (`npm run gate2:*`), run as a child process. The
//            request below mirrors the script's request, for the estimate only.
//   adapter  a provider with no GATE 2 script; the CLI builds the adapter from env
//            (default-registry.ts) and runs this request through submitTracked/pollTracked
//            (scripts/lib/harness.ts), so provider_jobs + cost tracking are exercised too.
// Plus one real post + takedown per configured platform (platforms/*.ts publishers).

export const LIVE_ORG_ID = 'gate2-smoke-org';

export interface LiveProviderTest {
  id: string;
  providerId: string;
  kind: 'script' | 'adapter' | 'voice-clone';
  /** package.json script for kind=script. */
  npmScript?: string;
  /** Env the test needs besides the provider key (missing → skipped with the reason). */
  requiredEnv: string[];
  /** Groups where any one key is enough (e.g. a provider with two kinds of key). */
  requiredEnvAnyOf?: string[][];
  /** The test writes to object storage: also needs STORAGE_PROVIDER's settings (S3 or R2). */
  usesStorage?: boolean;
  /** Built from env at run time (media URLs, voice id…). */
  request?: (env: Record<string, string | undefined>) => ProviderRequest;
  note?: string;
}

const num = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return raw?.trim() && Number.isFinite(n) && n > 0 ? n : fallback;
};

const SHOTSTACK_EDIT = {
  timeline: {
    background: '#1f1b16',
    tracks: [
      {
        clips: [
          {
            asset: { type: 'rich-text', text: 'PostMind Studio · GATE 2' },
            start: 0,
            length: 3,
            transition: { in: 'fade', out: 'fade' },
          },
        ],
      },
    ],
  },
  output: { format: 'mp4', resolution: 'sd', aspectRatio: '9:16' },
};

export const LIVE_PROVIDER_TESTS: readonly LiveProviderTest[] = [
  {
    id: 'anthropic',
    providerId: 'anthropic',
    kind: 'script',
    npmScript: 'gate2:anthropic',
    requiredEnv: ['ANTHROPIC_API_KEY'],
    request: () => ({
      capability: 'text_generation',
      organisationId: LIVE_ORG_ID,
      system:
        'You are the ideation layer of PostMind Studio. Turn a business brief into one concrete short-form video brief.',
      prompt:
        'Brief: a family bakery in Leeds launching a sourdough subscription. Audience: local professionals aged 25–40. Platform: TikTok.',
    }),
  },
  {
    id: 'runway',
    providerId: 'runway',
    kind: 'script',
    npmScript: 'gate2:runway',
    requiredEnv: ['RUNWAY_API_KEY'],
    request: () => ({
      capability: 'text_to_video',
      organisationId: LIVE_ORG_ID,
      prompt: 'gate2 runway clip',
      durationSec: 5,
      aspectRatio: '9:16',
    }),
  },
  {
    id: 'luma',
    providerId: 'luma',
    kind: 'script',
    npmScript: 'gate2:luma',
    requiredEnv: ['LUMA_API_KEY'],
    request: () => ({
      capability: 'text_to_video',
      organisationId: LIVE_ORG_ID,
      prompt: 'gate2 luma clip',
      durationSec: 5,
      aspectRatio: '9:16',
    }),
  },
  {
    // 20.20: no GATE 2 script; built from env (GOOGLE_GEMINI_API_KEY, VEO_MODEL) and tracked.
    id: 'veo',
    providerId: 'veo',
    kind: 'adapter',
    requiredEnv: ['GOOGLE_GEMINI_API_KEY'],
    request: () => ({
      capability: 'text_to_video',
      organisationId: LIVE_ORG_ID,
      prompt:
        'Slow push-in on a golden sourdough loaf on a flour-dusted wooden counter, morning window light, steam rising.',
      durationSec: 4,
      aspectRatio: '9:16',
    }),
    note: 'One 4 s 720p clip (Veo 3.1 Fast: $0.40). The output URI needs the API key to download; the pipeline copies it via VeoAdapter.fetchOutput.',
  },
  {
    id: 'heygen',
    providerId: 'heygen',
    kind: 'script',
    npmScript: 'gate2:heygen',
    requiredEnv: ['HEYGEN_API_KEY', 'HEYGEN_AVATAR_ID', 'HEYGEN_TEST_AUDIO_URL'],
    request: (env) => ({
      capability: 'avatar_video',
      organisationId: LIVE_ORG_ID,
      audioUrl: env.HEYGEN_TEST_AUDIO_URL ?? '',
      durationSec: num(env.HEYGEN_TEST_AUDIO_SEC, 10),
      aspectRatio: '9:16',
    }),
  },
  {
    id: 'elevenlabs',
    providerId: 'elevenlabs',
    kind: 'script',
    npmScript: 'gate2:elevenlabs',
    requiredEnv: ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'],
    request: (env) => ({
      capability: 'tts',
      organisationId: LIVE_ORG_ID,
      text: 'Fresh sourdough, baked this morning in Leeds, delivered to your door every week.',
      voiceId: env.ELEVENLABS_VOICE_ID ?? '',
      languageCode: 'en',
    }),
  },
  {
    id: 'shotstack',
    providerId: 'shotstack',
    kind: 'script',
    npmScript: 'gate2:shotstack',
    requiredEnv: ['SHOTSTACK_API_KEY'],
    request: () => ({
      capability: 'composition',
      organisationId: LIVE_ORG_ID,
      edit: SHOTSTACK_EDIT,
      outputDurationSec: 3,
    }),
    note: 'Stage environment unless SHOTSTACK_ENVIRONMENT=v1; check the hosted fonts render (APP_URL/fonts, or STUDIO_FONTS_BASE_URL when set).',
  },
  {
    id: 'router',
    providerId: 'router',
    kind: 'script',
    npmScript: 'gate2:router',
    requiredEnv: [],
    note: 'Routing decisions only; nothing is submitted (no spend).',
  },
  {
    id: 'elevenlabs-music',
    providerId: 'elevenlabs-music',
    kind: 'adapter',
    requiredEnv: ['ELEVENLABS_API_KEY'],
    request: () => ({
      capability: 'music',
      organisationId: LIVE_ORG_ID,
      prompt: 'Warm acoustic guitar, gentle and upbeat, morning bakery mood, instrumental.',
      durationSec: 10,
    }),
  },
  {
    id: 'assemblyai',
    providerId: 'assemblyai',
    kind: 'adapter',
    requiredEnv: ['ASSEMBLYAI_API_KEY', 'LIVE_TEST_MEDIA_URL'],
    request: (env) => ({
      capability: 'transcription',
      organisationId: LIVE_ORG_ID,
      mediaUrl: env.LIVE_TEST_MEDIA_URL ?? '',
      durationSec: num(env.LIVE_TEST_MEDIA_SEC, 10),
    }),
  },
  {
    id: 'openai-image',
    providerId: 'openai',
    kind: 'adapter',
    requiredEnv: ['OPENAI_API_KEY', 'S3_BUCKET_ASSETS'],
    usesStorage: true,
    request: () => ({
      capability: 'text_to_image',
      organisationId: LIVE_ORG_ID,
      prompt: 'A golden sourdough loaf on a flour-dusted wooden counter, morning light.',
      aspectRatio: '9:16',
    }),
  },
  {
    id: 'openai-embedding',
    providerId: 'openai',
    kind: 'adapter',
    requiredEnv: ['OPENAI_API_KEY'],
    request: () => ({
      capability: 'embedding',
      organisationId: LIVE_ORG_ID,
      input: ['sourdough subscription bakery Leeds'],
      dimensions: 1536,
    }),
  },
  {
    id: 'storyblocks-sfx',
    providerId: 'storyblocks-audio',
    kind: 'adapter',
    requiredEnv: ['STORYBLOCKS_API_PUBLIC_KEY', 'STORYBLOCKS_API_PRIVATE_KEY'],
    request: () => ({
      capability: 'sfx',
      organisationId: LIVE_ORG_ID,
      query: 'whoosh',
      maxDurationSec: 3,
    }),
    note: 'Subscription catalogue: no per-call cost.',
  },
  {
    id: 'elevenlabs-voice',
    providerId: 'elevenlabs',
    kind: 'voice-clone',
    requiredEnv: ['ELEVENLABS_API_KEY', 'LIVE_TEST_VOICE_SAMPLE_PATH'],
    note: 'Instant Voice Clone from the sample (a recording you have consent to clone), then deleted. Included in the ElevenLabs plan: no per-call cost.',
  },
];

/** Things the harness cannot do by itself; printed in the report for the operator. */
export const MANUAL_FOLLOW_UPS: readonly string[] = [
  'GATE 3 end-to-end: `npm run gate3` against staging (Claude, one Runway clip, ElevenLabs, Shotstack).',
];

export function missingEnv(
  test: LiveProviderTest,
  env: Record<string, string | undefined>,
): string[] {
  const names = test.usesStorage
    ? [...test.requiredEnv, ...storageRequiredEnv(env)]
    : test.requiredEnv;
  const anyOf = (test.requiredEnvAnyOf ?? [])
    .filter((group) => !group.some((name) => env[name]?.trim()))
    .map((group) => group.join(' or '));
  return [...names.filter((name) => !env[name]?.trim()), ...anyOf];
}

// ---------------------------------------------------------------- platform posts

export interface PostTarget {
  platform: Platform;
  tokenEnv: string;
  accountEnv: string;
}

/** LIVE_<PLATFORM>_ACCESS_TOKEN / LIVE_<PLATFORM>_ACCOUNT_ID for each publishing platform. */
export function postTargets(): PostTarget[] {
  return PLATFORMS.map((platform) => {
    const key = platform.toUpperCase();
    return {
      platform,
      tokenEnv: `LIVE_${key}_ACCESS_TOKEN`,
      accountEnv: `LIVE_${key}_ACCOUNT_ID`,
    };
  });
}

/** Env the post runs need: the test video (bytes + a public URL for Meta's pull-by-URL). */
export const POST_VIDEO_ENV = ['LIVE_TEST_VIDEO_PATH', 'LIVE_TEST_VIDEO_URL'] as const;

/** Least-visible settings per platform for a test post (read by each publisher's options). */
export function testPostOptions(platform: Platform): Record<string, unknown> {
  if (platform === 'tiktok') return { privacyLevel: 'SELF_ONLY' };
  if (platform === 'youtube' || platform === 'youtube_short') return { privacyStatus: 'private' };
  return {};
}

// ---------------------------------------------------------------- estimate + verdicts

export interface PlannedTest {
  test: LiveProviderTest;
  skipReason?: string;
  estimatePence: number | null;
}

export interface PlannedPost {
  target: PostTarget;
  skipReason?: string;
  takedownSupported: boolean;
}

export function formatPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

export function estimateLines(
  tests: readonly PlannedTest[],
  posts: readonly PlannedPost[],
): string[] {
  const runnable = tests.filter((t) => !t.skipReason);
  const total = runnable.reduce((sum, t) => sum + (t.estimatePence ?? 0), 0);
  const unknown = runnable.filter((t) => t.estimatePence === null).map((t) => t.test.id);
  return [
    'Cost estimate (from each adapter’s estimateCostPence; actual cost is recorded in provider_jobs):',
    ...tests.map((t) =>
      t.skipReason
        ? `  - ${t.test.id}: SKIPPED (${t.skipReason})`
        : `  - ${t.test.id}: ${t.estimatePence === null ? 'no estimator' : formatPence(t.estimatePence)}${t.test.note ? ` — ${t.test.note}` : ''}`,
    ),
    `  Total: ~${formatPence(total)}${unknown.length ? ` plus ${unknown.join(', ')} (no estimate)` : ''}`,
    'Posts (no provider cost; each is published to a TEST account, then taken down):',
    ...posts.map((p) =>
      p.skipReason
        ? `  - ${p.target.platform}: SKIPPED (${p.skipReason})`
        : `  - ${p.target.platform}: post + ${p.takedownSupported ? 'takedown via API' : 'MANUAL removal (no delete API)'}`,
    ),
  ];
}

export interface TestOutcome {
  id: string;
  ok: boolean | null;
  detail: string;
}

export function liveSections(input: {
  tests: TestOutcome[];
  posts: TestOutcome[];
  estimate: string[];
}): { verdict: Verdict; sections: GateSection[] } {
  const verdictOf = (items: TestOutcome[]): Verdict => {
    const ran = items.filter((i) => i.ok !== null);
    if (ran.some((i) => !i.ok)) return 'FAIL';
    if (ran.length === 0 || ran.length < items.length) return 'INCOMPLETE';
    return 'PASS';
  };
  const line = (o: TestOutcome) =>
    `- ${o.ok === null ? 'SKIPPED' : o.ok ? 'ok' : 'FAILED'} ${o.id}: ${o.detail}`;
  const providerVerdict = verdictOf(input.tests);
  const postVerdict = verdictOf(input.posts);
  const sections: GateSection[] = [
    { title: 'Estimate shown before running', lines: input.estimate },
    { title: 'Provider live tests', verdict: providerVerdict, lines: input.tests.map(line) },
    { title: 'Post + takedown per platform', verdict: postVerdict, lines: input.posts.map(line) },
    { title: 'Manual follow-ups', lines: MANUAL_FOLLOW_UPS.map((m) => `- ${m}`) },
  ];
  const all: Verdict[] = [providerVerdict, postVerdict];
  return {
    verdict: all.includes('FAIL') ? 'FAIL' : all.includes('INCOMPLETE') ? 'INCOMPLETE' : 'PASS',
    sections,
  };
}
