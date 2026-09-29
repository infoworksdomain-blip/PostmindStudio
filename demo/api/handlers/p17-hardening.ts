// Phase 17 sample states (BACKLOG 17.9 and the untitled project). Every failure reason is stored
// exactly as the server stores it — `<code>: <detail>` — so the real screens translate the code
// (src/lib/client/failure-reasons.ts) and show only non-Studio text (a provider's message)
// untranslated:
//   planning_failed wrapping kill_switch_workspace   (plan-project.ts + runtime.ts failureReason)
//   asset_generation_failed with shot numbers        (compose-video.ts), each shot `<provider>/<class>: …`
//   content_safety_block from the quality gate       (run-quality-gate.ts summarise())
//   youtube_quota_deferred on a scheduled post       (publish-video.ts deferForQuota)
//   kill_switch_platform and tiktok/rate_limited     (publish-video.ts onPublishVideoFailed)
// Plus a project with no name (17.9: name null → "Untitled video" in the reader's language)
// whose quality panel carries detailKey + detailParams with numbers.
import type { QualityIssue } from '@/lib/client/types';
import { CONNECTIONS, P17_PROJECTS, PROJECTS, RENDERS } from '../ids';
import type { ProjectContent, ShotContent } from './projects-content';
import {
  ago,
  baseProject,
  buildRender,
  buildScripts,
  DAY,
  fmt,
  HOUR,
  MIN,
  putProject,
  type ProjectRec,
} from './projects-store';
import { addPublication, getPublication } from './publications-store';

const shot = (
  treatment: ShotContent['treatment'],
  durationSec: number,
  kind: ShotContent['kind'],
  scene: string,
  voiceover: string | null,
  onScreen: string | null,
): ShotContent => ({ treatment, durationSec, kind, scene, camera: null, voiceover, onScreen });

const GARDEN: ProjectContent = {
  scene: 'flatlay',
  brief: {
    hook: 'Four bakes that taste like the garden.',
    keyMessage:
      'Elderflower buns, courgette loaf, strawberry tarts and a herb focaccia, from June.',
    targetAudience: 'Weekend brunch crowd in north Leeds',
    tone: 'Sunny, relaxed',
  },
  shots: [
    shot(
      'AI_CLIP',
      4,
      'flatlay',
      'Summer bakes laid out on a garden table.',
      'Summer’s on the counter.',
      'SUMMER GARDEN BAKES',
    ),
    shot(
      'AI_CLIP',
      5,
      'cake',
      'Strawberry tarts glazed under the sun.',
      'Strawberry tarts, glazed to order.',
      null,
    ),
    shot(
      'STOCK_FOOTAGE',
      4,
      'market',
      'Elderflower heads swaying in a hedge.',
      'Elderflower from the allotment.',
      null,
    ),
    shot(
      'AI_CLIP',
      5,
      'sourdough',
      'A herb focaccia torn open.',
      'And a focaccia full of garden herbs.',
      null,
    ),
    shot('TEXT_CARD', 3, 'logo', 'End card.', 'From Saturday.', 'From Saturday · Chapel Allerton'),
  ],
};

const KNIFE: ProjectContent = {
  scene: 'kitchen',
  brief: {
    hook: 'The one knife trick for a hot loaf.',
    keyMessage: 'Let the loaf rest, then slice with a serrated knife and a light sawing motion.',
    targetAudience: 'Home bakers',
    tone: 'Practical, friendly',
  },
  shots: [
    shot(
      'AI_CLIP',
      4,
      'kitchen',
      'A crusty loaf on a board, steam rising.',
      'Straight out of the oven?',
      'WAIT 20 MINUTES',
    ),
    shot(
      'AI_CLIP',
      5,
      'kitchen',
      'A serrated knife sawing gently through the crust.',
      'Serrated knife, light strokes.',
      null,
    ),
    shot('TEXT_CARD', 3, 'logo', 'End card.', 'More tips every Tuesday.', 'Tips every Tuesday'),
  ],
};

const RYE: ProjectContent = {
  scene: 'sourdough',
  brief: {
    hook: 'Dark, dense and worth the wait.',
    keyMessage: 'Our 100% rye is back on Thursdays, baked for 36 hours.',
    targetAudience: 'Regulars who ask for rye',
    tone: 'Calm, confident',
  },
  shots: [
    shot(
      'AI_CLIP',
      4,
      'sourdough',
      'A dark rye loaf on a linen cloth.',
      'Our rye is back.',
      'RYE IS BACK',
    ),
    shot(
      'AI_CLIP',
      5,
      'baker',
      'Hands pressing seeds into the rye dough.',
      'Thirty-six hours, start to finish.',
      null,
    ),
    shot(
      'AI_CLIP',
      4,
      'coffee',
      'A slice with butter next to a flat white.',
      'Best with butter and nothing else.',
      null,
    ),
    shot('TEXT_CARD', 3, 'logo', 'End card.', 'Thursdays only.', 'Thursdays only'),
  ],
};

// ------------------------------------------------------------------ 17.9 failure reasons

function easterWindow(): ProjectRec {
  const { id, name } = P17_PROJECTS.easterWindow;
  // Stopped while planning: the organisation (workspace) kill switch was engaged. The wrapper
  // code carries the cause, and the UI renders both sentences.
  return baseProject(id, name, {
    state: 'FAILED',
    scene: 'storefront',
    description: 'Film the Easter window display: bunnies, hot cross buns, pastel macarons.',
    targetFormats: [fmt('tiktok', '9:16', 20), fmt('instagram_reel', '9:16', 20)],
    costActualPence: 4,
    errorReason: 'planning_failed: kill_switch_workspace: Studio kill switch active (workspace)',
    createdAt: ago(6 * HOUR),
    updatedAt: ago(6 * HOUR - 2 * MIN),
  });
}

function gardenBakes(): ProjectRec {
  const { id, name } = P17_PROJECTS.gardenBakes;
  const p = baseProject(id, name, {
    state: 'FAILED',
    scene: GARDEN.scene,
    brief: GARDEN.brief,
    description: GARDEN.brief?.keyMessage ?? null,
    targetFormats: [fmt('tiktok', '9:16', 21)],
    costActualPence: 168,
    // compose-video.ts: `asset_generation_failed: shot <n>: <the shot's errorReason>; …`
    errorReason:
      'asset_generation_failed: shot 2: runway/content_policy: Prompt was flagged by the moderation system; shot 4: luma/timeout: Generation did not finish within 600 seconds',
    createdAt: ago(20 * HOUR),
    updatedAt: ago(19 * HOUR),
  });
  p.scripts = buildScripts(id, p.targetFormats, GARDEN);
  const failed: Record<number, string> = {
    1: 'runway/content_policy: Prompt was flagged by the moderation system',
    3: 'luma/timeout: Generation did not finish within 600 seconds',
  };
  for (const script of p.scripts)
    script.shots.forEach((s, i) => {
      const reason = failed[i];
      if (!reason) return;
      s.state = 'FAILED';
      s.errorReason = reason;
      s.assetId = null;
      s.voiceAssetId = null;
      s.assets = [];
    });
  return p;
}

const BLOCKED_SAFETY: QualityIssue = {
  code: 'content_safety',
  status: 'failed',
  severity: 'block',
  detail: 'Blocked: very_bloody=0.91',
  detailKey: 'safetyBlocked',
  detailParams: { classes: 'very_bloody=0.91' },
};

function knifeSkills(): ProjectRec {
  const { id, name } = P17_PROJECTS.knifeSkills;
  const p = baseProject(id, name, {
    state: 'QUALITY_FAILED',
    scene: KNIFE.scene,
    brief: KNIFE.brief,
    description: KNIFE.brief?.keyMessage ?? null,
    targetFormats: [fmt('tiktok', '9:16', 12)],
    costActualPence: 97,
    // run-quality-gate.ts summarise(): `<platform>/<check> [BLOCK]: <detail>`.
    errorReason: 'content_safety_block: tiktok/content_safety [BLOCK]: Blocked: very_bloody=0.91',
    createdAt: ago(28 * HOUR),
    updatedAt: ago(27 * HOUR),
  });
  p.scripts = buildScripts(id, p.targetFormats, KNIFE);
  p.renders = p.scripts.map((s) => {
    const render = buildRender(p, s, {
      id: 'rnd-knife-tiktok',
      state: 'FAILED',
      createdAt: ago(27 * HOUR),
    });
    return {
      ...render,
      qualityIssues: (render.qualityIssues ?? []).map((q) =>
        q.code === 'content_safety' ? BLOCKED_SAFETY : q,
      ),
    };
  });
  return p;
}

// ------------------------------------------------------------------ 17.9 untitled video

/** Checks with translated details and numbers (review.quality.details.*). */
const RICH_CHECKS: QualityIssue[] = [
  {
    code: 'audio_sync',
    status: 'passed',
    severity: 'info',
    detail: 'voiceover fits all 4 shots',
    detailKey: 'audioSyncPassed',
    detailParams: { count: 4 },
  },
  {
    code: 'caption_sync',
    status: 'passed',
    severity: 'info',
    detail: '6 captions within ±120 ms of the voiceover',
    detailKey: 'captionSyncPassed',
    detailParams: { count: 6, ms: 120 },
  },
  {
    code: 'codec',
    status: 'passed',
    severity: 'info',
    detail: 'h264 (High) in mp4',
    detailKey: 'codec',
    detailParams: { codec: 'h264', profile: 'High', format: 'mp4' },
  },
  {
    code: 'watermark',
    status: 'passed',
    severity: 'info',
    detail: 'visible in the sampled frames (match 0.94, 0.91, 0.96)',
    detailKey: 'watermarkVisible',
    detailParams: { scores: '0.94, 0.91, 0.96' },
  },
];

function untitled(): ProjectRec {
  const { id } = P17_PROJECTS.untitled;
  const p = baseProject(id, null, {
    state: 'READY_FOR_REVIEW',
    scene: RYE.scene,
    brief: RYE.brief,
    description: RYE.brief?.keyMessage ?? null,
    targetFormats: [fmt('tiktok', '9:16', 16), fmt('youtube_short', '9:16', 16)],
    costActualPence: 149,
    createdAt: ago(4 * HOUR),
    updatedAt: ago(90 * MIN),
    completedAt: ago(90 * MIN),
    metadata: { music: { status: 'generated', reused: false, durationSec: 16 } },
  });
  p.scripts = buildScripts(id, p.targetFormats, RYE);
  p.renders = p.scripts.map((s) => {
    const render = buildRender(p, s, {
      id: `rnd-untitled-${s.targetPlatform}`,
      createdAt: ago(90 * MIN),
    });
    return { ...render, qualityIssues: [...(render.qualityIssues ?? []), ...RICH_CHECKS] };
  });
  return p;
}

[easterWindow, gardenBakes, knifeSkills, untitled].forEach((make) => putProject(make()));

// ------------------------------------------------------------------ publications

const at = (days: number, hh: number, mm = 0) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hh, mm, 0, 0);
  return d.toISOString();
};

const ritual = getPublication('pub-ritual-shorts');
// Both failures go on the project that is already partly published, so no other state changes.
const ws = PROJECTS.wholesale;

// 17.9 / 13.x: YouTube's daily upload quota was reached; the publisher re-scheduled the post for
// just after the Pacific-time reset (deferForQuota), so it is SCHEDULED with a coded reason.
addPublication({
  id: 'pub-ritual-youtube-quota',
  projectId: PROJECTS.morningRitual.id,
  renderId: RENDERS.ritualShorts,
  // A second Shorts post of the same render (a publish-now that hit the quota).
  platform: 'youtube_short',
  platformAccountId: CONNECTIONS.youtube.accountId,
  state: 'SCHEDULED',
  scheduledFor: at(1, 7, 5),
  publishedAt: null,
  platformPostId: null,
  platformUrl: null,
  caption: ritual?.caption ?? 'Our morning ritual, 5am to first loaf out.',
  hashtags: ['bakerylife', 'leeds'],
  errorReason:
    'youtube_quota_deferred: YouTube upload quota reached; retrying after the daily reset',
  errorCode: 'quota_exceeded',
  retryCount: 0,
  createdAt: ago(3 * HOUR),
  project: { id: PROJECTS.morningRitual.id, name: PROJECTS.morningRitual.name },
  metadata: { quotaDeferredUntil: at(1, 7, 5), quotaDeferrals: 1 },
});

// A platform kill switch halted the post (safe to re-drive once released).
addPublication({
  id: 'pub-wholesale-facebook-feed-halted',
  projectId: ws.id,
  renderId: `${RENDERS.wholesaleYoutube}-fbfeed`,
  platform: 'facebook_feed',
  platformAccountId: CONNECTIONS.facebook.accountId,
  state: 'FAILED',
  scheduledFor: ago(26 * HOUR),
  publishedAt: null,
  platformPostId: null,
  platformUrl: null,
  caption: 'Wholesale bread for Leeds cafés: delivered by 7am, six days a week.',
  hashtags: ['wholesale', 'leeds'],
  errorReason: 'kill_switch_platform: Studio kill switch active (platform)',
  errorCode: 'unknown',
  retryCount: 1,
  createdAt: ago(3 * DAY),
  project: { id: ws.id, name: ws.name },
});

// A platform error class with the platform's own message (shown untranslated).
addPublication({
  id: 'pub-wholesale-x-rate-limited',
  projectId: ws.id,
  renderId: `${RENDERS.wholesaleYoutube}-x`,
  platform: 'x',
  platformAccountId: CONNECTIONS.x.accountId,
  state: 'FAILED',
  scheduledFor: null,
  publishedAt: null,
  platformPostId: null,
  platformUrl: null,
  caption: 'Cafés: our wholesale list is open. Delivered by 7am.',
  hashtags: ['wholesale'],
  errorReason: 'x/rate_limited: Too Many Requests',
  errorCode: 'rate_limited',
  retryCount: 2,
  createdAt: ago(30 * HOUR),
  project: { id: ws.id, name: ws.name },
});
