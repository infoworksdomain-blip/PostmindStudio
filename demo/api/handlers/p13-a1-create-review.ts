// Phase 13 track A1 demo: script edit + regenerate (13.1), shot delete (13.2; the asset swap is
// the PATCH /shots/:id branch in review.ts → swapShotAsset below), whole-video overlay listing
// (13.3) and per-slide overlays (13.4). Same shapes as the real routes.
import { DemoHttpError, route } from '../registry';
import { makeOverlay, overlaysFor, slideOverlays, styleKeys, videoOverlays } from './overlays-data';
import { startFullRun, startShotRun } from './pipeline-sim';
import {
  allProjects,
  findRender,
  findShot,
  getProject,
  newId,
  setMeta,
  touch,
  type ProjectRec,
  type ScriptRec,
} from './projects-store';
import { slidesByProject } from './slideshow-data';

type Body = Record<string, unknown>;
const obj = (v: unknown): Body =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Body) : {};
const bad = (m: string) => new DemoHttpError(400, 'validation_error', m);
const SCRIPT_EDITABLE = new Set(['READY_FOR_REVIEW', 'QUALITY_FAILED', 'FAILED', 'REJECTED']);
const OVERLAY_EDITABLE = new Set([
  'DRAFT',
  'FAILED',
  'REJECTED',
  'QUALITY_FAILED',
  'READY_FOR_REVIEW',
]);
const MAX_PER_SLIDE = 12;

function assertScriptEditable(p: ProjectRec): void {
  if (!SCRIPT_EDITABLE.has(p.state))
    throw new DemoHttpError(
      409,
      'conflict',
      `The script can be edited once the project has finished (project is ${p.state})`,
    );
}

function findScript(id: string): { project: ProjectRec; script: ScriptRec } {
  for (const project of allProjects()) {
    const script = project.scripts.find((s) => s.id === id);
    if (script) return { project, script };
  }
  throw new DemoHttpError(404, 'not_found', 'Script not found');
}

/** Mark the project's current renders out of date (metadata.staleRenders). */
function markStale(p: ProjectRec, onlyScriptId?: string): string[] {
  const current = Array.isArray(p.metadata?.staleRenders)
    ? (p.metadata.staleRenders as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const ids = p.renders
    .filter((r) => !onlyScriptId || r.scriptId === onlyScriptId)
    .map((r) => r.id);
  const stale = [...new Set([...current, ...ids])];
  setMeta(p, { staleRenders: stale });
  return stale;
}

function withOverlays(script: ScriptRec) {
  return {
    ...script,
    shots: script.shots.map((shot, i) => {
      const { kind: _kind, assets: _assets, ...row } = shot;
      return { ...row, overlays: overlaysFor(shot, i) };
    }),
  };
}

const text = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === 'string' ? v.trim() || null : undefined;

route('GET', '/scripts/:id', ({ params }) => ({
  script: withOverlays(findScript(params.id ?? '').script),
}));

route('PATCH', '/scripts/:id', ({ params, body }) => {
  const { project, script } = findScript(params.id ?? '');
  assertScriptEditable(project);
  const b = obj(body);
  const edits = Array.isArray(b.shots) ? b.shots.map(obj) : [];
  const fullText = typeof b.fullText === 'string' ? b.fullText.trim() : undefined;
  if (!fullText && edits.length === 0) throw bad('Nothing to update');
  for (const edit of edits)
    if (!script.shots.some((s) => s.id === edit.id))
      throw bad(`Shot ${String(edit.id)} is not part of this script`);
  const voiceRegenerated: string[] = [];
  for (const edit of edits) {
    const shot = script.shots.find((s) => s.id === edit.id);
    if (!shot) continue;
    const voiceover = text(edit.voiceoverText);
    const onScreen = text(edit.onScreenText);
    if (voiceover !== undefined && voiceover !== shot.voiceoverText) {
      shot.voiceoverText = voiceover;
      voiceRegenerated.push(shot.id);
    }
    if (onScreen !== undefined) shot.onScreenText = onScreen;
  }
  if (fullText) script.fullText = fullText;
  const stale = markStale(project);
  const first = voiceRegenerated[0];
  if (first) startShotRun(project, script, first);
  else touch(project);
  return {
    script: withOverlays(script),
    staleRenders: stale,
    runId: first ? String(project.metadata?.runId ?? '') : null,
    voiceRegenerated,
  };
});

route('POST', '/scripts/:id/regenerate', ({ params, body }) => {
  const { project, script } = findScript(params.id ?? '');
  assertScriptEditable(project);
  if (project.sourceType === 'SLIDESHOW' || project.sourceType === 'UPLOAD')
    throw new DemoHttpError(
      409,
      'conflict',
      `A ${project.sourceType} project has no generated script to rewrite`,
    );
  if (!project.brief)
    throw new DemoHttpError(
      409,
      'conflict',
      'The project has no Layer 1 brief to reuse; generate it instead',
    );
  const instruction = text(obj(body).instruction);
  const stale = markStale(project, script.id);
  if (instruction) setMeta(project, { lastScriptInstruction: instruction });
  startFullRun(project);
  return {
    status: 202,
    body: {
      project: { id: project.id, state: 'QUEUED' },
      runId: String(project.metadata?.runId ?? ''),
      staleRenders: stale,
    },
  };
});

/** PATCH /shots/:id { assetId | imageLibraryId } (routed here from review.ts). */
export function swapShotAsset(shotId: string, b: Body) {
  const { project, shot } = findShot(shotId);
  assertScriptEditable(project);
  const assetId = typeof b.assetId === 'string' ? b.assetId : null;
  const imageId = typeof b.imageLibraryId === 'string' ? b.imageLibraryId : null;
  if (Boolean(assetId) === Boolean(imageId))
    throw bad('Give exactly one of assetId or imageLibraryId');
  const newAsset = assetId ?? newId('ast');
  shot.assetId = newAsset;
  shot.visualTreatment = imageId ? 'IMAGE_STILL' : 'USER_UPLOAD';
  shot.state = 'READY';
  shot.assets = [
    {
      id: newAsset,
      kind: imageId ? 'IMAGE' : 'VIDEO_CLIP',
      mimeType: imageId ? 'image/png' : 'video/mp4',
      durationSec: imageId ? null : shot.durationSec,
      source: imageId ? `image-library:${imageId}` : 'upload',
      publicUrl: null,
    },
    ...shot.assets.filter((a) => a.kind === 'AUDIO_VOICE'),
  ];
  const staleRenders = markStale(project);
  touch(project);
  const { kind: _kind, assets: _assets, ...row } = shot;
  return { shot: row, staleRenders };
}

route('DELETE', '/shots/:id', ({ params }) => {
  const { project, script, shot } = findShot(params.id ?? '');
  assertScriptEditable(project);
  if (script.shots.length <= 1)
    throw new DemoHttpError(
      409,
      'conflict',
      'A script needs at least one shot; delete the project instead',
    );
  script.shots = script.shots
    .filter((s) => s.id !== shot.id)
    .map((s, i) => ({ ...s, sortOrder: i }));
  script.targetDurationSec = Math.max(
    1,
    Math.round(script.shots.reduce((t, s) => t + s.durationSec, 0)),
  );
  const narration = script.shots
    .map((s) => s.voiceoverText)
    .filter(Boolean)
    .join(' ');
  if (narration) script.fullText = narration;
  const staleRenders = markStale(project);
  touch(project);
  return { script: withOverlays(script), staleRenders };
});

// ------------------------------------------------------------------ whole-video (13.3)

route('GET', '/renders/:id/overlays', ({ params }) => {
  const { project, render } = findRender(params.id ?? '');
  const siblings = project.renders.filter((r) => r.targetPlatform === render.targetPlatform);
  return { data: siblings.flatMap((r) => videoOverlays.get(r.id) ?? []) };
});

// ------------------------------------------------------------------ per-slide (13.4)

function findSlide(slideId: string) {
  for (const [projectId, slides] of slidesByProject) {
    const slide = slides.find((s) => s.id === slideId);
    if (slide) return { project: getProject(projectId), slide };
  }
  throw new DemoHttpError(404, 'not_found', 'Slide not found');
}

route('GET', '/slides/:id/overlays', ({ params }) => {
  const { slide } = findSlide(params.id ?? '');
  return { data: slideOverlays.get(slide.id) ?? [] };
});

route('POST', '/slides/:id/overlays', ({ params, body }) => {
  const { project, slide } = findSlide(params.id ?? '');
  if (!OVERLAY_EDITABLE.has(project.state))
    throw new DemoHttpError(
      409,
      'conflict',
      `Overlays cannot be edited while the project is ${project.state}`,
    );
  const b = obj(body);
  const value = typeof b.text === 'string' ? b.text.trim() : '';
  if (!value) throw bad('text is required');
  const start = typeof b.startAtSec === 'number' ? b.startAtSec : 0;
  const end = typeof b.endAtSec === 'number' ? b.endAtSec : slide.durationSec;
  if (end <= start) throw bad('endAtSec must be after startAtSec');
  if (end > slide.durationSec + 1e-6)
    throw bad(`endAtSec must be within the ${slide.durationSec}s it is attached to`);
  const list = slideOverlays.get(slide.id) ?? [];
  if (list.length >= MAX_PER_SLIDE) throw bad(`At most ${MAX_PER_SLIDE} overlays per slide`);
  const overlay = makeOverlay(
    { shotId: null, renderId: null, slideId: slide.id },
    {
      text: value.slice(0, 500),
      startAtSec: start,
      endAtSec: end,
      presetId: typeof b.presetId === 'string' ? b.presetId : null,
      style: styleKeys(obj(b.style)),
      sortOrder: list.length,
    },
  );
  slideOverlays.set(slide.id, [...list, overlay]);
  return { status: 201, body: { overlay } };
});
