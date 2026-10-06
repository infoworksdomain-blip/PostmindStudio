// 22.1 / 22.2 Fastlane-style formats in the demo: the business's demo-video bank (a seeded demo
// plus anything uploaded as demo_video), Create → "Hook + demo" (no_demo_video when the bank is
// empty) and "Wall of text", the simulated plan for both, and one seeded sample of each ready for
// review. Shapes follow services/projects.ts, services/demo-videos.ts and the plan workers
// (queue/workers/plan-hook-demo.ts, plan-wall-of-text.ts): a silent reaction hook carrying the one
// hook line, then the business's demo; one text block over a calm background with music.
import { hookDemoTiming, TARGET_DEFAULT_SEC } from '@/lib/studio/formats/hook-demo';
import { WALL_DEFAULT_SEC } from '@/lib/studio/formats/wall-of-text';
import type { TargetFormat } from '@/lib/client/types';
import { DEMO_BUSINESS_ID } from '../ids';
import { DemoHttpError, route } from '../registry';
import { demoVideos, seedDemoVideo } from './p13-a1-uploads';
import type { ProjectContent } from './projects-content';
import {
  ago,
  baseProject,
  buildRender,
  buildScripts,
  HOUR,
  MIN,
  putProject,
  type ProjectRec,
} from './projects-store';

type Body = Record<string, unknown>;
const obj = (v: unknown): Body =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Body) : {};
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;
const bad = (m: string) => new DemoHttpError(400, 'validation_error', m);

seedDemoVideo(DEMO_BUSINESS_ID);

route('GET', '/uploads/demo-videos', ({ query }) => ({
  data: demoVideos(query.get('businessId') ?? DEMO_BUSINESS_ID),
}));

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const HOOK_SOURCES = new Set(['ai_creator', 'library']);
const REACTIONS = new Set(['surprised', 'curious', 'wait_what']);
const LAYOUTS = new Set(['sequential', 'stacked']);
const MIXES = new Set(['demo', 'balanced', 'music']);
const BACKGROUNDS = new Set(['calm', 'nature', 'city', 'abstract']);
const pick = (v: unknown, allowed: Set<string>, fallback: string) =>
  typeof v === 'string' && allowed.has(v) ? v : fallback;

/**
 * POST /projects for the two formats: their fixed length and metadata, or the API's refusal
 * (no_demo_video for a hook + demo video without a demo; a wall of text needs a brief or text).
 */
export function formatProject(
  b: Body,
  sourceType: string,
  businessId: string,
  hasBrief: boolean,
): { durationSec: number; metadata: Body; sourceRef: string | null } | null {
  if (sourceType === 'HOOK_DEMO') {
    const h = obj(b.hookDemo);
    const bank = demoVideos(businessId);
    const demo = str(h.demoUploadId) ? bank.find((u) => u.id === h.demoUploadId) : bank[0];
    if (!demo)
      throw new DemoHttpError(
        422,
        'no_demo_video',
        'Upload a demo video of your product or app first: a hook + demo video shows your own demo after the hook',
      );
    const hookLine = str(h.hookLine) ?? null;
    if (hookLine && words(hookLine) > 12) throw bad('The hook line can have at most 12 words');
    return {
      durationSec: TARGET_DEFAULT_SEC,
      sourceRef: demo.id,
      metadata: {
        hookDemo: {
          demoUploadId: demo.id,
          demoAssetId: `ast-${demo.id}`,
          demoFileName: demo.fileName,
          demoDurationSec: demo.durationSec,
          hookLine,
          hookSource: pick(h.hookSource, HOOK_SOURCES, 'ai_creator'),
          reaction: pick(h.reaction, REACTIONS, 'surprised'),
          layout: pick(h.layout, LAYOUTS, 'sequential'),
          audioMix: pick(h.audioMix, MIXES, 'balanced'),
          targetSec: TARGET_DEFAULT_SEC,
          writtenHookLine: null,
        },
      },
    };
  }
  if (sourceType === 'WALL_OF_TEXT') {
    const w = obj(b.wallOfText);
    const text = str(w.text) ?? null;
    if (!text && !hasBrief) throw bad('brief is required');
    if (text && words(text) > 60) throw bad('The text can have at most 60 words');
    const sec = Number(w.durationSec);
    const durationSec = Number.isInteger(sec) && sec >= 6 && sec <= 12 ? sec : WALL_DEFAULT_SEC;
    return {
      durationSec,
      sourceRef: null,
      metadata: {
        wallOfText: {
          text,
          background: pick(w.background, BACKGROUNDS, 'calm'),
          durationSec,
          writtenText: null,
        },
      },
    };
  }
  return null;
}

const SAMPLE_HOOK = 'I stopped queuing for my morning coffee';
const SAMPLE_WALL =
  'Three things our regulars know\n- Bread is best before noon\n- Sourdough keeps for days\n- Freeze it sliced, toast it frozen';

/** The simulated plan: the hook line (or the owner's), a 3 s reaction, then the demo. */
export function hookDemoContent(p: ProjectRec): ProjectContent {
  const h = obj(p.metadata?.hookDemo);
  const line = str(h.hookLine) ?? SAMPLE_HOOK;
  const timing = hookDemoTiming({
    targetSec: typeof h.targetSec === 'number' ? h.targetSec : TARGET_DEFAULT_SEC,
    demoDurationSec: typeof h.demoDurationSec === 'number' ? h.demoDurationSec : 30,
  });
  return {
    scene: 'kitchen',
    brief: null,
    shots: [
      {
        treatment: 'AI_CLIP',
        durationSec: timing.hookSec,
        kind: 'kitchen',
        scene:
          'A fictional adult, phone selfie: glances at the screen, then looks up surprised and delighted. No speech.',
        camera: 'Handheld selfie',
        voiceover: null,
        onScreen: line,
        transitionOut: 'cut',
      },
      {
        treatment: 'USER_UPLOAD',
        durationSec: timing.demoSec,
        kind: 'storefront',
        scene: `Demo video: ${String(h.demoFileName ?? 'your demo')}`,
        camera: null,
        voiceover: null,
        onScreen: null,
        transitionOut: 'cut',
      },
    ],
  };
}

/** The simulated plan: one calm background shot carrying the text block for the whole video. */
export function wallOfTextContent(p: ProjectRec): ProjectContent {
  const w = obj(p.metadata?.wallOfText);
  return {
    scene: 'flatlay',
    brief: null,
    shots: [
      {
        treatment: 'STOCK_FOOTAGE',
        durationSec: typeof w.durationSec === 'number' ? w.durationSec : WALL_DEFAULT_SEC,
        kind: 'flatlay',
        scene: 'calm aesthetic slow motion background, soft light, no people, no text',
        camera: null,
        voiceover: null,
        onScreen: str(w.text) ?? SAMPLE_WALL,
        transitionOut: 'cut',
      },
    ],
  };
}

const vertical = (platforms: string[], sec: number): TargetFormat[] =>
  platforms.map((platform) => ({ platform, aspectRatio: '9:16', duration: sec }));

function seed(
  id: string,
  name: string,
  sourceType: 'HOOK_DEMO' | 'WALL_OF_TEXT',
  metadata: Body,
  content: (p: ProjectRec) => ProjectContent,
  sec: number,
): void {
  const p = baseProject(id, name, {
    state: 'READY_FOR_REVIEW',
    scene: sourceType === 'HOOK_DEMO' ? 'kitchen' : 'flatlay',
    sourceType,
    targetFormats: vertical(['tiktok', 'instagram_reel'], sec),
    costActualPence: sourceType === 'HOOK_DEMO' ? 62 : 24,
    createdAt: ago(5 * HOUR),
    updatedAt: ago(40 * MIN),
    completedAt: ago(40 * MIN),
    metadata: { ...metadata, music: { status: 'generated', reused: false, durationSec: sec } },
  });
  p.scripts = buildScripts(id, p.targetFormats, content(p));
  p.renders = p.scripts.map((s) => buildRender(p, s, { createdAt: ago(40 * MIN) }));
  putProject(p);
}

seed(
  'prj-hook-demo-order-ahead',
  'Hook + demo: order ahead',
  'HOOK_DEMO',
  {
    hookDemo: {
      demoUploadId: 'upl-demo-order-ahead',
      demoAssetId: 'ast-upl-demo-order-ahead',
      demoFileName: 'order-ahead-app-demo.mp4',
      demoDurationSec: 34,
      hookLine: null,
      hookSource: 'ai_creator',
      reaction: 'surprised',
      layout: 'sequential',
      audioMix: 'balanced',
      targetSec: TARGET_DEFAULT_SEC,
      writtenHookLine: SAMPLE_HOOK,
    },
  },
  hookDemoContent,
  TARGET_DEFAULT_SEC,
);

seed(
  'prj-wall-bread-tips',
  'Wall of text: bread tips',
  'WALL_OF_TEXT',
  {
    wallOfText: {
      text: null,
      background: 'calm',
      durationSec: WALL_DEFAULT_SEC,
      writtenText: SAMPLE_WALL,
    },
  },
  wallOfTextContent,
  WALL_DEFAULT_SEC,
);
