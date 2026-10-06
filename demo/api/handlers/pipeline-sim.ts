// Simulated generation pipeline for the demo: timers move a project through the real states
// (QUEUED → PLANNING → ASSETS_GENERATING → RENDERING → QUALITY_CHECKING → READY_FOR_REVIEW) over
// ~20 s while scripts, shots and renders appear — the Review screen polls every 4 s. Also shot
// re-runs, re-renders with overlays, slideshow auto-populate and the project budget pause.
import { isVagueBrief } from '@/lib/client/brief-hint';
import { VAGUE_BRIEF_REASON, directionOptionsOf } from '@/lib/studio/pipeline/vague-brief';
import { CONTENT, contentForBrief, type ProjectContent } from './projects-content';
import { approve } from './projects-publish';
import { uploadContent } from './p13-a1-uploads';
import { startCarouselRun } from './p21-carousels';
import { hookDemoContent, wallOfTextContent } from './p22-formats';
import {
  buildRender,
  buildScripts,
  nowIso,
  qualityIssues,
  setMeta,
  shotAssets,
  touch,
  type ProjectRec,
  type ScriptRec,
} from './projects-store';
import {
  DEMO_IMAGES,
  demoImage,
  libraryId,
  makeSlide,
  slidesByProject,
  slidesFor,
  slidesToShots,
} from './slideshow-data';

const timers = new Map<string, number[]>();
const runs = new Map<string, number>();
let runSeq = 0;

/** Cancel every pending step of this project's run. */
export function stopRun(projectId: string): void {
  for (const t of timers.get(projectId) ?? []) window.clearTimeout(t);
  timers.delete(projectId);
  runs.delete(projectId);
}

function newRun(p: ProjectRec): number {
  stopRun(p.id);
  const run = ++runSeq;
  runs.set(p.id, run);
  setMeta(p, { runId: `run-${run}` });
  return run;
}

function at(p: ProjectRec, run: number, sec: number, step: () => void): void {
  const t = window.setTimeout(() => {
    if (runs.get(p.id) !== run) return;
    step();
    p.updatedAt = nowIso();
  }, sec * 1000);
  timers.set(p.id, [...(timers.get(p.id) ?? []), t]);
}

/** Spend `pence`; false (and the project paused) when it crosses 90% of the project budget. */
function spend(p: ProjectRec, pence: number): boolean {
  p.costActualPence += pence;
  const budget = p.costBudgetPence;
  if (budget !== null && p.costActualPence >= budget * 0.9) {
    stopRun(p.id);
    const pounds = (budget / 100).toFixed(2);
    touch(p, {
      state: 'FAILED',
      errorReason: `cost_cap_paused: project spend reached 90% of its £${pounds} budget`,
    });
    return false;
  }
  return true;
}

export function contentFor(p: ProjectRec): ProjectContent {
  if (p.sourceType === 'SLIDESHOW')
    return { scene: p.scene, brief: null, shots: slidesToShots(p.id) };
  if (p.sourceType === 'UPLOAD') return uploadContent(p);
  // 22.1 / 22.2: a reaction hook + the demo; one text block over a calm background.
  if (p.sourceType === 'HOOK_DEMO') return hookDemoContent(p);
  if (p.sourceType === 'WALL_OF_TEXT') return wallOfTextContent(p);
  return CONTENT[p.id] ?? contentForBrief(p.description ?? p.name ?? '');
}

/** A fresh render for a script, keeping the variant's render id so links to it stay valid. */
function pendingRender(p: ProjectRec, script: ScriptRec) {
  const previous = p.renders.find((r) => r.scriptId === script.id);
  return buildRender(p, script, { state: 'PENDING', ...(previous && { id: previous.id }) });
}

function renderAll(p: ProjectRec, run: number, start: number): number {
  let t = start;
  at(p, run, t, () => touch(p, { state: 'RENDERING' }));
  // Scripts may not exist yet when a full run is scheduled: look each one up when it renders.
  p.targetFormats.forEach((_f, i) => {
    t += 1.5;
    at(p, run, t, () => {
      const script = p.scripts[i];
      if (!script) return;
      p.renders = [pendingRender(p, script), ...p.renders.filter((r) => r.scriptId !== script.id)];
    });
  });
  t += 1.5;
  at(p, run, t, () => touch(p, { state: 'QUALITY_CHECKING' }));
  t += 2.5;
  at(p, run, t, () => finish(p));
  return t;
}

function finish(p: ProjectRec): void {
  for (const r of p.renders)
    if (r.qualityCheckState === 'PENDING') {
      if (!spend(p, r.costPence)) return;
      r.qualityCheckState = 'PASSED';
      r.qualityIssues = qualityIssues(false);
    }
  runs.delete(p.id);
  timers.delete(p.id);
  // 13.1 / 13.2: fresh renders reflect every script and shot edit.
  setMeta(p, { staleRenders: [] });
  const music = p.metadata?.music as { status?: string } | undefined;
  if (!music || music.status !== 'off_for_plan')
    setMeta(p, {
      music: {
        status: 'generated',
        reused: false,
        durationSec: p.scripts[0]?.targetDurationSec ?? 20,
      },
    });
  touch(p, { state: 'READY_FOR_REVIEW', completedAt: nowIso(), errorReason: null });
  if (p.reviewPolicy === 'AUTO_APPROVE') approve(p, { auto: true });
}

function readyShot(script: ScriptRec, index: number): void {
  const shot = script.shots[index];
  if (!shot) return;
  shot.state = 'READY';
  shot.assetId = `${shot.id}-clip`;
  shot.voiceAssetId = shot.voiceoverText ? `${shot.id}-voice` : null;
  shot.assets = shotAssets(shot.id, {
    treatment: shot.visualTreatment as ProjectContent['shots'][number]['treatment'],
    durationSec: shot.durationSec,
    voiceover: shot.voiceoverText,
  });
}

/**
 * 20.18: three directions for a brief that is too vague (live: ideation writes them from the
 * business profile; the demo builds them from the brief itself).
 */
export function demoDirectionOptions(brief: string): string[] {
  const topic = brief.replace(/\s+/g, ' ').trim() || 'your business';
  return directionOptionsOf([
    `A short, friendly intro to ${topic} for new local customers`,
    `Three quick tips about ${topic} that your customers will want to save`,
    `A behind-the-scenes look at ${topic} with a clear call to action`,
  ]);
}

/** Live's rule (brief-hint.ts; ideation never asks twice in a row) for a BRIEF project. */
function needsDirection(p: ProjectRec, directionChosen: boolean): boolean {
  if (p.sourceType !== 'BRIEF' || directionChosen || p.metadata?.lastBriefVague === true)
    return false;
  return isVagueBrief(p.description);
}

/** POST /projects/:id/generate — a full run from the brief (or the slides). */
export function startFullRun(p: ProjectRec, opts: { directionChosen?: boolean } = {}): void {
  // 21.6: a carousel writes its thread, picks pictures and renders slides (p21-carousels.ts).
  if (p.sourceType === 'CAROUSEL') {
    stopRun(p.id);
    return startCarouselRun(p);
  }
  const run = newRun(p);
  const content = contentFor(p);
  touch(p, { state: 'QUEUED', errorReason: null, completedAt: null });
  if (needsDirection(p, opts.directionChosen === true)) {
    // Live: planning runs ideation, which answers "too vague"; the project rests in DRAFT.
    at(p, run, 1.5, () => touch(p, { state: 'PLANNING' }));
    at(p, run, 3, () => {
      setMeta(p, {
        directionOptions: demoDirectionOptions(p.description ?? ''),
        lastBriefVague: true,
      });
      runs.delete(p.id);
      timers.delete(p.id);
      touch(p, { state: 'DRAFT', errorReason: VAGUE_BRIEF_REASON });
    });
    return;
  }
  setMeta(p, {
    directionOptions: [],
    lastBriefVague: false,
    ...(opts.directionChosen && { directionChosen: true }),
  });
  p.renders = [];
  p.scripts = [];
  at(p, run, 1.5, () => touch(p, { state: 'PLANNING' }));
  at(p, run, 4.5, () => {
    if (!spend(p, 12)) return;
    if (content.brief) p.brief = content.brief;
    p.scripts = buildScripts(p.id, p.targetFormats, content, 'PLANNED');
    touch(p, { state: 'ASSETS_GENERATING' });
  });
  const n = content.shots.length;
  for (let i = 0; i < n; i++) {
    at(p, run, 5.5 + i * 1.4, () =>
      p.scripts.forEach((s) => {
        const shot = s.shots[i];
        if (shot) shot.state = 'GENERATING';
      }),
    );
    at(p, run, 6.7 + i * 1.4, () => {
      if (!spend(p, 9 * p.scripts.length)) return;
      p.scripts.forEach((s) => readyShot(s, i));
    });
  }
  renderAll(p, run, 7 + n * 1.4);
}

/** The seeded mid-render project picks up where it was when first opened. */
export function resumeRendering(p: ProjectRec): void {
  if (runs.has(p.id) || p.state !== 'RENDERING') return;
  const run = newRun(p);
  let t = 0;
  p.scripts.forEach((script) => {
    t += 2;
    at(p, run, t, () => {
      p.renders = [pendingRender(p, script), ...p.renders.filter((r) => r.scriptId !== script.id)];
    });
  });
  at(p, run, t + 1.5, () => touch(p, { state: 'QUALITY_CHECKING' }));
  at(p, run, t + 4, () => finish(p));
}

/** Regenerate / re-voice one shot, then re-render that variant. */
export function startShotRun(p: ProjectRec, script: ScriptRec, shotId: string): void {
  const run = newRun(p);
  const index = script.shots.findIndex((s) => s.id === shotId);
  const shot = script.shots[index];
  if (!shot) return;
  shot.state = 'QUEUED';
  shot.errorReason = null;
  touch(p, { state: 'ASSETS_QUEUED', errorReason: null, completedAt: null });
  at(p, run, 1, () => {
    shot.state = 'GENERATING';
    touch(p, { state: 'ASSETS_GENERATING' });
  });
  at(p, run, 3.5, () => {
    if (!spend(p, 9)) return;
    readyShot(script, index);
    touch(p, { state: 'RENDERING' });
  });
  at(p, run, 5, () => {
    p.renders = [pendingRender(p, script), ...p.renders.filter((r) => r.scriptId !== script.id)];
    touch(p, { state: 'QUALITY_CHECKING' });
  });
  at(p, run, 7.5, () => finish(p));
}

/** POST /renders/:id/rerender — re-compose every variant with the current overlays. */
export function startRerender(p: ProjectRec): void {
  const run = newRun(p);
  touch(p, { state: 'ASSETS_QUEUED', errorReason: null, completedAt: null });
  renderAll(p, run, 1);
}

// ------------------------------------------------------------------ slideshow auto-populate

const BAKES = [
  'Country sourdough',
  'Almond croissant',
  'Seeded rye',
  'Brown butter blondie',
  'Pistachio swirl',
  'Bakewell slice',
  'Cheese scone',
  'Cinnamon knot',
];

/** POST /projects/:id/auto-populate — SCANNING for ~5 s, then text and images are filled in. */
export function startAutoPopulate(p: ProjectRec): void {
  const run = newRun(p);
  const returnTo = p.state;
  setMeta(p, { populate: { id: `pop-${run}`, returnTo } });
  touch(p, { state: 'SCANNING' });
  at(p, run, 5, () => {
    const topic = String(
      (p.metadata?.slideshow as { topic?: unknown } | undefined)?.topic ?? p.name,
    );
    let pick = 0;
    const used = new Set(slidesFor(p.id).map((s) => demoImage(s.imageAssetId)?.id));
    const freeImage = (): string | null => {
      const free =
        DEMO_IMAGES.find((i) => !used.has(i.id)) ?? DEMO_IMAGES[pick % DEMO_IMAGES.length];
      if (!free) return null;
      used.add(free.id);
      return libraryId(free.id);
    };
    const filled = slidesFor(p.id).map((s) => {
      const c = { ...s.content };
      if (c.pendingText) {
        delete c.pendingText;
        if (c.role === 'hook') c.text = topic.slice(0, 120);
        else if (c.role === 'cta') c.text = 'Call Lane, Leeds · open from 7am';
        else {
          c.text = BAKES[pick % BAKES.length];
          c.caption = 'Baked this morning';
          pick += 1;
        }
      }
      if (s.slideType === 'TEXT_CARD' && !c.text) c.text = topic.slice(0, 120);
      const needsImage =
        ['IMAGE_STILL', 'IMAGE_KENBURNS', 'PRODUCT'].includes(s.slideType) && !s.imageAssetId;
      if (s.slideType === 'PRODUCT' && !c.name) c.name = BAKES[pick++ % BAKES.length];
      return makeSlide(p.id, s.id, s.sortOrder, s.slideType, c, {
        ...s,
        imageAssetId: needsImage ? freeImage() : s.imageAssetId,
      });
    });
    slidesByProject.set(p.id, filled);
    runs.delete(p.id);
    touch(p, { state: returnTo === 'SCANNING' ? 'DRAFT' : returnTo });
  });
}
