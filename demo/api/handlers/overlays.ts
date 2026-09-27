// Overlay editor endpoints (services/overlays.ts shapes): presets, per-shot overlays (add / edit /
// delete), a preview render (a recorded sample clip with the overlay text), bulk apply across a
// render, and re-render with the current overlays.
import type { Overlay, OverlayPreset } from '@/components/studio/overlays/types';
import { sampleVideo, type Aspect } from '../../media';
import { DemoHttpError, route } from '../registry';
import { DEMO_BUSINESS_ID, DEMO_ORG_ID } from '../ids';
import { startRerender } from './pipeline-sim';
import { findRender, findShot, getProject, newId, type ProjectRec } from './projects-store';
import {
  findOverlay,
  makeOverlay,
  overlaysFor,
  presets,
  shotOverlays,
  styleKeys,
  videoOverlays,
} from './overlays-data';
import { slidesByProject } from './slideshow-data';

const EDITABLE = new Set(['DRAFT', 'FAILED', 'REJECTED', 'QUALITY_FAILED', 'READY_FOR_REVIEW']);
const RERENDERABLE = new Set(['READY_FOR_REVIEW', 'QUALITY_FAILED', 'REJECTED']);
const GROUPS = new Set(['hook', 'subtitle', 'cta', 'quote', 'statistic', 'story', 'brand']);
const MAX_PER_SHOT = 12;
const MAX_WHOLE_VIDEO = 6;

type Body = Record<string, unknown>;
const obj = (v: unknown): Body =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Body) : {};
const bad = (m: string) => new DemoHttpError(400, 'validation_error', m);

function assertEditable(p: ProjectRec): void {
  if (!EDITABLE.has(p.state))
    throw new DemoHttpError(
      409,
      'conflict',
      `Overlays cannot be changed while the project is ${p.state}`,
    );
}

function timing(
  b: Body,
  maxEnd: number,
  current?: Overlay,
): { startAtSec: number; endAtSec: number } {
  const startAtSec = typeof b.startAtSec === 'number' ? b.startAtSec : (current?.startAtSec ?? 0);
  const endAtSec =
    typeof b.endAtSec === 'number' ? b.endAtSec : (current?.endAtSec ?? Math.min(2, maxEnd));
  if (startAtSec < 0 || endAtSec <= startAtSec) throw bad('endAtSec must be after startAtSec');
  if (endAtSec > maxEnd + 0.01) throw bad(`Overlay must end by ${maxEnd.toFixed(1)} s`);
  return { startAtSec, endAtSec };
}

function textOf(b: Body, required: boolean): string | undefined {
  if (b.text === undefined && !required) return undefined;
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text || text.length > 500) throw bad('text must be 1–500 characters');
  return text;
}

const presetId = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v) return null;
  if (!presets.some((p) => p.id === v)) throw bad('presetId is not a usable preset');
  return v;
};

// ------------------------------------------------------------------ presets

route('GET', '/overlay-presets', ({ query }) => {
  const group = query.get('group');
  const businessId = query.get('businessId');
  const order = { BUILT_IN: 0, ORG: 1, BUSINESS: 2 };
  const data = presets
    .filter(
      (p) =>
        (!group || p.group === group) &&
        (p.scope !== 'BUSINESS' || (businessId && p.businessId === businessId)),
    )
    .sort(
      (a, b) =>
        order[a.scope] - order[b.scope] ||
        a.group.localeCompare(b.group) ||
        a.name.localeCompare(b.name),
    );
  return { data };
});

route('POST', '/overlay-presets', ({ body }) => {
  const b = obj(body);
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 80) throw bad('name must be 1–80 characters');
  if (typeof b.group !== 'string' || !GROUPS.has(b.group)) throw bad('group is invalid');
  const business = b.scope === 'business';
  if (business && typeof b.businessId !== 'string')
    throw bad('businessId is required for business-scoped presets');
  const created: OverlayPreset = {
    id: newId('ovp'),
    scope: business ? 'BUSINESS' : 'ORG',
    organisationId: DEMO_ORG_ID,
    businessId: business ? String(b.businessId ?? DEMO_BUSINESS_ID) : null,
    name,
    group: b.group,
    parameters: obj(b.parameters),
    brandSubstitution: b.brandSubstitution !== false,
  };
  presets.push(created);
  return { status: 201, body: { preset: created } };
});

function ownPreset(id: string): OverlayPreset {
  const p = presets.find((x) => x.id === id);
  if (!p) throw new DemoHttpError(404, 'not_found', 'Preset not found');
  if (p.scope === 'BUILT_IN')
    throw new DemoHttpError(409, 'conflict', 'Built-in presets cannot be changed');
  return p;
}

route('PATCH', '/overlay-presets/:id', ({ params, body }) => {
  const p = ownPreset(params.id ?? '');
  const b = obj(body);
  if (typeof b.name === 'string' && b.name.trim()) p.name = b.name.trim();
  if (typeof b.group === 'string' && GROUPS.has(b.group)) p.group = b.group;
  if (b.parameters) p.parameters = { ...p.parameters, ...obj(b.parameters) };
  return { preset: p };
});

route('DELETE', '/overlay-presets/:id', ({ params }) => {
  const p = ownPreset(params.id ?? '');
  presets.splice(presets.indexOf(p), 1);
  return { deleted: true };
});

// ------------------------------------------------------------------ shot overlays

route('GET', '/shots/:id/overlays', ({ params }) => {
  const { script, shot } = findShot(params.id ?? '');
  return {
    data: [...overlaysFor(shot, script.shots.indexOf(shot))].sort(
      (a, b) => a.sortOrder - b.sortOrder,
    ),
  };
});

route('POST', '/shots/:id/overlays', ({ params, body }) => {
  const { project, script, shot } = findShot(params.id ?? '');
  assertEditable(project);
  const list = overlaysFor(shot, script.shots.indexOf(shot));
  if (list.length >= MAX_PER_SHOT) throw bad(`A shot can have at most ${MAX_PER_SHOT} overlays`);
  const b = obj(body);
  const overlay = makeOverlay(
    { shotId: shot.id, renderId: null },
    {
      text: textOf(b, true) ?? '',
      ...timing(b, shot.durationSec),
      presetId: presetId(b.presetId),
      style: obj(b.style),
      sortOrder: list.length,
    },
  );
  list.push(overlay);
  return { status: 201, body: { overlay } };
});

function overlayContext(id: string) {
  const found = findOverlay(id);
  if (!found) throw new DemoHttpError(404, 'not_found', 'Overlay not found');
  if (found.kind === 'slide') {
    for (const [projectId, slides] of slidesByProject) {
      const slide = slides.find((x) => x.id === found.key);
      if (!slide) continue;
      const project = getProject(projectId);
      return {
        ...found,
        project,
        maxEnd: slide.durationSec,
        aspect: project.targetFormats[0]?.aspectRatio ?? '9:16',
        scene: project.scene,
      };
    }
    throw new DemoHttpError(404, 'not_found', 'Overlay not found');
  }
  if (found.kind === 'shot') {
    const { project, script, shot } = findShot(found.key);
    return {
      ...found,
      project,
      maxEnd: shot.durationSec,
      aspect: script.targetAspectRatio,
      scene: shot.kind,
    };
  }
  const { project, render } = findRender(found.key);
  return {
    ...found,
    project,
    maxEnd: render.durationSec,
    aspect: render.aspectRatio,
    scene: project.scene,
  };
}

route('PATCH', '/overlays/:id', ({ params, body }) => {
  const ctx = overlayContext(params.id ?? '');
  assertEditable(ctx.project);
  const b = obj(body);
  if (Object.keys(b).length === 0) throw bad('Nothing to update');
  const text = textOf(b, false);
  const next: Overlay = {
    ...ctx.overlay,
    ...(text !== undefined && { text }),
    ...timing(b, ctx.maxEnd, ctx.overlay),
    ...(typeof b.sortOrder === 'number' && { sortOrder: b.sortOrder }),
    ...styleKeys(obj(b.style)),
  };
  ctx.list.splice(ctx.list.indexOf(ctx.overlay), 1, next);
  return { overlay: next };
});

route('DELETE', '/overlays/:id', ({ params }) => {
  const ctx = overlayContext(params.id ?? '');
  assertEditable(ctx.project);
  ctx.list.splice(ctx.list.indexOf(ctx.overlay), 1);
  return { deleted: true };
});

route('POST', '/overlays/:id/preview', async ({ params }) => {
  const ctx = overlayContext(params.id ?? '');
  const aspect = (
    ['9:16', '16:9', '1:1', '4:5'].includes(ctx.aspect) ? ctx.aspect : '9:16'
  ) as Aspect;
  const url = await sampleVideo({
    scene: ctx.scene,
    aspect,
    seconds: 3,
    caption: ctx.overlay.text,
  });
  if (!url)
    throw new DemoHttpError(
      503,
      'preview_unavailable',
      'This browser can’t record the sample clip.',
    );
  const start = Math.max(0, ctx.overlay.startAtSec - 0.5);
  return {
    preview: {
      url,
      expiresInSec: 900,
      range: { start, length: Math.min(ctx.maxEnd - start, ctx.overlay.endAtSec - start + 0.5) },
    },
  };
});

// ------------------------------------------------------------------ bulk + rerender

route('POST', '/renders/:id/overlays/bulk', ({ params, body }) => {
  const { project, render } = findRender(params.id ?? '');
  assertEditable(project);
  const b = obj(body);
  const input = obj(b.overlay);
  const text = textOf(input, true) ?? '';
  const pid = presetId(input.presetId);
  const ids = Array.isArray(b.applyToShotIds)
    ? b.applyToShotIds.filter((x): x is string => typeof x === 'string')
    : null;
  if (!ids) {
    const list = videoOverlays.get(render.id) ?? [];
    if (list.length >= MAX_WHOLE_VIDEO)
      throw bad(`A video can have at most ${MAX_WHOLE_VIDEO} whole-video overlays`);
    const overlay = makeOverlay(
      { shotId: null, renderId: render.id },
      { text, ...timing(input, render.durationSec), presetId: pid, style: obj(input.style) },
    );
    videoOverlays.set(render.id, [...list, overlay]);
    return { status: 201, body: { data: [overlay] } };
  }
  const script = project.scripts.find((s) => s.id === render.scriptId);
  const created = ids.map((shotId) => {
    const shot = script?.shots.find((s) => s.id === shotId);
    if (!shot || !script) throw bad(`Shot ${shotId} is not part of this render`);
    const list = overlaysFor(shot, script.shots.indexOf(shot));
    const overlay = makeOverlay(
      { shotId, renderId: null },
      {
        text,
        ...timing(input, shot.durationSec),
        presetId: pid,
        style: obj(input.style),
        sortOrder: list.length,
      },
    );
    shotOverlays.set(shotId, [...list, overlay]);
    return overlay;
  });
  return { status: 201, body: { data: created } };
});

route('POST', '/renders/:id/rerender', ({ params }) => {
  const { project } = findRender(params.id ?? '');
  if (!RERENDERABLE.has(project.state))
    throw new DemoHttpError(
      409,
      'conflict',
      `Project is ${project.state}; re-render needs a reviewed project`,
    );
  startRerender(getProject(project.id));
  return {
    status: 202,
    body: { projectId: project.id, runId: String(project.metadata?.runId ?? '') },
  };
});
