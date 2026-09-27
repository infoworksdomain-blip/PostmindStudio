// Seeds one project per interesting state (ids.ts PROJECTS) with scripts, shots, renders,
// approvals and the metadata the Review screen reads (music, review decision, auto-publish).
import { CONNECTIONS, DEMO_USER_ID, PROJECTS, PUBLICATIONS, RENDERS, TEMPLATES } from '../ids';
import { getPublication } from './publications-store';
import { CONTENT } from './projects-content';
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
  type ScriptRec,
} from './projects-store';
import { slidesToShots } from './slideshow-data';

const vertical = (platforms: string[], sec = 30) => platforms.map((p) => fmt(p, '9:16', sec));

function withRenders(
  p: ProjectRec,
  ids: Record<string, string>,
  opts: { failLoudness?: string; createdAt: string },
): ProjectRec {
  p.renders = p.scripts.map((s: ScriptRec) =>
    buildRender(p, s, {
      id: ids[s.targetPlatform],
      state: opts.failLoudness === s.targetPlatform ? 'FAILED' : 'PASSED',
      failLoudness: opts.failLoudness === s.targetPlatform,
      createdAt: opts.createdAt,
    }),
  );
  return p;
}

function seeded(p: ProjectRec, contentKey = p.id): ProjectRec {
  const content = CONTENT[contentKey];
  if (content) {
    p.brief = content.brief;
    p.description = content.brief?.keyMessage ?? p.description;
    if (p.state !== 'DRAFT') p.scripts = buildScripts(p.id, p.targetFormats, content);
  }
  return p;
}

const approved = (id: string, at: string, by: string, note: string | null = null) => ({
  id,
  state: 'APPROVED',
  note,
  createdAt: at,
  resolvedByUserId: by,
});

function spring(): ProjectRec {
  const { id, name } = PROJECTS.springMenu;
  const p = seeded(
    baseProject(id, name, {
      state: 'READY_FOR_REVIEW',
      scene: 'flatlay',
      targetFormats: vertical(['tiktok', 'youtube_short', 'instagram_reel'], 25),
      costActualPence: 212,
      costBudgetPence: 500,
      createdAt: ago(2 * DAY),
      updatedAt: ago(40 * MIN),
      completedAt: ago(40 * MIN),
      metadata: {
        music: { status: 'generated', reused: false, durationSec: 25 },
        review: {
          decision: 'needs_review',
          code: 'price_claim',
          reason:
            'Needs a person to check it: the video states a discount (“20% off”), so an owner must approve price claims.',
          at: ago(40 * MIN),
        },
      },
    }),
  );
  return withRenders(
    p,
    {
      tiktok: RENDERS.springTiktok,
      youtube_short: RENDERS.springShorts,
      instagram_reel: RENDERS.springReels,
    },
    { createdAt: ago(40 * MIN) },
  );
}

function sourdoughClass(): ProjectRec {
  const { id, name } = PROJECTS.sourdoughClass;
  const p = seeded(
    baseProject(id, name, {
      state: 'PUBLISHED',
      scene: 'baker',
      targetFormats: vertical(['tiktok', 'youtube_short', 'instagram_reel'], 21),
      costActualPence: 186,
      createdAt: ago(8 * DAY),
      updatedAt: ago(6 * DAY),
      completedAt: ago(7 * DAY),
      metadata: { music: { status: 'generated', reused: true, durationSec: 21 } },
      approvals: [
        approved('apr-class', ago(6 * DAY + 2 * HOUR), DEMO_USER_ID, 'Lovely — ship it.'),
      ],
    }),
  );
  return withRenders(
    p,
    {
      tiktok: RENDERS.classTiktok,
      youtube_short: RENDERS.classShorts,
      instagram_reel: RENDERS.classReels,
    },
    { createdAt: ago(7 * DAY) },
  );
}

function loyalty(): ProjectRec {
  const { id, name } = PROJECTS.loyaltyCard;
  // Mid-run: every shot is ready and the renders are being composed (pipeline-sim resumes it
  // when the project is first opened).
  return seeded(
    baseProject(id, name, {
      state: 'RENDERING',
      scene: 'coffee',
      targetFormats: vertical(['tiktok', 'instagram_reel'], 16),
      costActualPence: 104,
      createdAt: ago(25 * MIN),
      updatedAt: ago(2 * MIN),
      metadata: { runId: 'run-loyalty-1' },
    }),
  );
}

function buns(): ProjectRec {
  const { id, name } = PROJECTS.hotCrossBuns;
  const p = seeded(
    baseProject(id, name, {
      state: 'QUALITY_FAILED',
      scene: 'croissant',
      targetFormats: vertical(['tiktok'], 16),
      costActualPence: 131,
      errorReason: 'Quality check failed on TikTok: audio loudness is above the platform target.',
      createdAt: ago(3 * DAY),
      updatedAt: ago(5 * HOUR),
      metadata: {
        music: {
          status: 'failed',
          reason: 'The music provider timed out three times; the video uses narration only.',
        },
      },
    }),
  );
  return withRenders(
    p,
    { tiktok: RENDERS.bunsTiktok },
    { failLoudness: 'tiktok', createdAt: ago(5 * HOUR) },
  );
}

function fiveBakes(): ProjectRec {
  const { id, name } = PROJECTS.fiveBakes;
  const p = baseProject(id, name, {
    state: 'READY_FOR_REVIEW',
    sourceType: 'SLIDESHOW',
    scene: 'cake',
    description: 'Five weekend bakes from the counter, one per slide.',
    targetFormats: vertical(['tiktok'], 20),
    costActualPence: 38,
    createdAt: ago(26 * HOUR),
    updatedAt: ago(3 * HOUR),
    completedAt: ago(3 * HOUR),
    metadata: {
      slideshow: { templateId: 'sst-listicle-5', topic: '5 bakes to try this weekend' },
      music: { status: 'generated', reused: false, durationSec: 22 },
    },
  });
  p.scripts = buildScripts(id, p.targetFormats, {
    scene: 'cake',
    brief: null,
    shots: slidesToShots(id),
  });
  return withRenders(p, { tiktok: RENDERS.fiveBakesTiktok }, { createdAt: ago(3 * HOUR) });
}

function ritual(): ProjectRec {
  const { id, name } = PROJECTS.morningRitual;
  const tt = getPublication(PUBLICATIONS.ritualTiktokScheduled);
  const yt = getPublication(PUBLICATIONS.ritualShortsScheduled);
  const approvedAt = ago(50 * MIN);
  const p = seeded(
    baseProject(id, name, {
      state: 'APPROVED',
      sourceType: 'LIBRARY_REFERENCE',
      referenceVideoId: 'lib-pov-morning-bake',
      referenceMode: 'TEMPLATE',
      scene: 'baker',
      targetFormats: vertical(['tiktok', 'youtube_short'], 18),
      costActualPence: 167,
      reviewPolicy: 'AUTO_APPROVE',
      publishPolicy: 'AUTO_ON_APPROVAL',
      createdAt: ago(5 * HOUR),
      updatedAt: approvedAt,
      completedAt: approvedAt,
      approvals: [
        approved(
          'apr-ritual',
          approvedAt,
          'system:auto-approve',
          'Auto-approved: trusted creator, all checks passed.',
        ),
      ],
      metadata: {
        reference: { videoId: 'lib-pov-morning-bake', mode: 'TEMPLATE' },
        music: { status: 'generated', reused: false, durationSec: 18 },
        review: { decision: 'auto_approved', code: 'trusted_creator', at: approvedAt },
        autoPublish: {
          targets: [
            {
              platform: 'tiktok',
              connectionId: CONNECTIONS.tiktok.id,
              caption: 'Our morning ritual, 5am to first loaf out.',
              hashtags: ['bakerylife', 'pov'],
              scheduleOffsetMinutes: 2880,
            },
            {
              platform: 'youtube_short',
              connectionId: CONNECTIONS.youtube.id,
              scheduleOffsetMinutes: 2940,
            },
          ],
        },
        autoPublishResult: {
          at: approvedAt,
          trigger: 'auto',
          status: 'created',
          results: [
            {
              index: 0,
              platform: 'tiktok',
              account: CONNECTIONS.tiktok.account,
              status: 'created',
              publicationId: PUBLICATIONS.ritualTiktokScheduled,
              scheduledFor: tt?.scheduledFor ?? null,
            },
            {
              index: 1,
              platform: 'youtube_short',
              account: CONNECTIONS.youtube.account,
              status: 'created',
              publicationId: PUBLICATIONS.ritualShortsScheduled,
              scheduledFor: yt?.scheduledFor ?? null,
            },
          ],
        },
      },
    }),
  );
  return withRenders(
    p,
    { tiktok: RENDERS.ritualTiktok, youtube_short: RENDERS.ritualShorts },
    { createdAt: ago(70 * MIN) },
  );
}

function wholesale(): ProjectRec {
  const { id, name } = PROJECTS.wholesale;
  const p = seeded(
    baseProject(id, name, {
      state: 'PARTIALLY_PUBLISHED',
      scene: 'market',
      targetFormats: [fmt('youtube', '16:9', 22), fmt('linkedin_video', '16:9', 22)],
      costActualPence: 244,
      templateId: TEMPLATES.introduce.id,
      createdAt: ago(4 * DAY),
      updatedAt: ago(2 * DAY),
      completedAt: ago(3 * DAY),
      metadata: { music: { status: 'off_for_plan' } },
      approvals: [approved('apr-wholesale', ago(2 * DAY + HOUR), DEMO_USER_ID)],
    }),
  );
  return withRenders(
    p,
    { youtube: RENDERS.wholesaleYoutube, linkedin_video: RENDERS.wholesaleLinkedin },
    { createdAt: ago(3 * DAY) },
  );
}

function christmas(): ProjectRec {
  const { id, name } = PROJECTS.christmas;
  const p = seeded(
    baseProject(id, name, {
      state: 'FAILED',
      scene: 'cake',
      brandKitId: 'bk-seasonal',
      targetFormats: vertical(['tiktok', 'instagram_reel'], 17),
      costBudgetPence: 300,
      costActualPence: 276,
      errorReason: 'cost_cap_paused: project spend reached 90% of its £3.00 budget',
      createdAt: ago(9 * HOUR),
      updatedAt: ago(8 * HOUR),
      metadata: {
        briefHints: { targetAudience: 'Local families', callToAction: 'Pre-order in store' },
      },
    }),
  );
  // The pause hit mid-way through asset generation: the last two shots were never made.
  for (const script of p.scripts)
    for (const shot of script.shots.slice(2)) {
      shot.state = 'PLANNED';
      shot.assetId = null;
      shot.voiceAssetId = null;
      shot.assets = [];
    }
  return p;
}

function meetTheBakers(): ProjectRec {
  const { id, name } = PROJECTS.meetTheBakers;
  return baseProject(id, name, {
    state: 'DRAFT',
    scene: 'baker',
    description:
      'Introduce Tom, Priya and Josh — the three bakers behind every loaf — with a line each about their favourite bake.',
    targetFormats: vertical(['tiktok', 'instagram_reel'], 30),
    createdAt: ago(30 * MIN),
    updatedAt: ago(30 * MIN),
    metadata: {
      briefHints: {
        targetAudience: 'Regulars and new followers',
        callToAction: 'Say hello at the counter',
      },
    },
  });
}

export function seedProjects(): void {
  [
    spring,
    sourdoughClass,
    loyalty,
    buns,
    fiveBakes,
    ritual,
    wholesale,
    christmas,
    meetTheBakers,
  ].forEach((make) => putProject(make()));
}
