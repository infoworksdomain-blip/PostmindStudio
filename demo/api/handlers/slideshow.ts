// Slideshow endpoints (services/slideshows.ts shapes): slides list / add / edit / delete /
// reorder, auto-populate (SCANNING, then filled), and slideshow templates.
import {
  SLIDE_TYPES,
  type Slide,
  type SlideContent,
  type SlideType,
} from '@/components/studio/slideshow/types';
import { DemoHttpError, route } from '../registry';
import { DEMO_ORG_ID } from '../ids';
import { startAutoPopulate } from './pipeline-sim';
import { getProject, newId, touch, type ProjectRec } from './projects-store';
import {
  addSlideshowTemplate,
  DEMO_IMAGES,
  linkImage,
  relinkSlides,
  listSlideshowTemplates,
  makeSlide,
  slidesByProject,
  slidesFor,
} from './slideshow-data';

const EDITABLE = new Set(['DRAFT', 'FAILED', 'REJECTED', 'QUALITY_FAILED', 'READY_FOR_REVIEW']);
const MAX_SLIDES = 40;

function slideshowProject(id: string): ProjectRec {
  const p = getProject(id);
  if (p.sourceType !== 'SLIDESHOW')
    throw new DemoHttpError(404, 'not_found', 'Slideshow project not found');
  return p;
}

function assertEditable(p: ProjectRec): void {
  if (!EDITABLE.has(p.state))
    throw new DemoHttpError(
      409,
      'conflict',
      `Slides cannot be changed while the project is ${p.state}`,
    );
}

function findSlide(slideId: string): { project: ProjectRec; slide: Slide } {
  for (const [projectId, slides] of slidesByProject) {
    const slide = slides.find((s) => s.id === slideId);
    if (slide) return { project: getProject(projectId), slide };
  }
  throw new DemoHttpError(404, 'not_found', 'Slide not found');
}

/** Store the project's slides renumbered 0..n-1 in the given order. */
function save(projectId: string, ordered: Slide[]): Slide[] {
  const next = ordered.map((s, i) =>
    makeSlide(projectId, s.id, i, s.slideType, s.content, { ...s, sortOrder: i }),
  );
  slidesByProject.set(projectId, next);
  return next;
}

const isType = (v: unknown): v is SlideType =>
  typeof v === 'string' && (SLIDE_TYPES as readonly string[]).includes(v);
const clamp = (n: number) => Math.min(10, Math.max(0.5, Math.round(n * 10) / 10));

let linking: Promise<void> | null = null;
/** Link the demo's slide images to the Business image library's ids (read once, best effort). */
function linkLibrary(businessId: string): Promise<void> {
  linking ??= (async () => {
    try {
      const res = await fetch(
        `/api/studio/image-library?businessId=${encodeURIComponent(businessId)}&limit=100`,
      );
      const json = (await res.json()) as { data?: Array<{ id: string; tags?: string[] }> };
      const lib = json.data ?? [];
      const used = new Set<string>();
      for (const img of DEMO_IMAGES) {
        const tagged = lib.find(
          (l) =>
            !used.has(l.id) &&
            img.tags.some((t) => (l.tags ?? []).some((lt) => lt.includes(t) || t.includes(lt))),
        );
        const match = tagged ?? lib.find((l) => !used.has(l.id));
        if (!match) break;
        used.add(match.id);
        linkImage(img.id, match.id);
      }
      relinkSlides();
    } catch {
      // The library isn't available: slides keep the demo's own image ids.
    }
  })();
  return linking;
}

route('GET', '/projects/:id/slides', async ({ params }) => {
  const p = slideshowProject(params.id ?? '');
  await linkLibrary(p.businessId);
  return { data: slidesFor(p.id) };
});

route('POST', '/projects/:id/slides', ({ params, body }) => {
  const p = slideshowProject(params.id ?? '');
  assertEditable(p);
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isType(b.slideType))
    throw new DemoHttpError(400, 'validation_error', 'slideType is invalid');
  const slides = slidesFor(p.id);
  if (slides.length >= MAX_SLIDES)
    throw new DemoHttpError(400, 'validation_error', `At most ${MAX_SLIDES} slides`);
  const at = typeof b.sortOrder === 'number' ? Math.min(b.sortOrder, slides.length) : slides.length;
  const slide = makeSlide(
    p.id,
    newId('sld'),
    at,
    b.slideType,
    (b.content as SlideContent | undefined) ?? {},
  );
  const saved = save(p.id, [...slides.slice(0, at), slide, ...slides.slice(at)]);
  touch(p);
  return { status: 201, body: { slide: saved[at] } };
});

route('PATCH', '/slides/:id', ({ params, body }) => {
  const { project, slide } = findSlide(params.id ?? '');
  assertEditable(project);
  const b = (body ?? {}) as Record<string, unknown>;
  if (Object.keys(b).length === 0)
    throw new DemoHttpError(400, 'validation_error', 'Nothing to update');
  const patch = (b.content ?? {}) as SlideContent;
  const content: SlideContent = { ...slide.content, ...patch };
  if (patch.text !== undefined) delete content.pendingText;
  const slideType = isType(b.slideType) ? b.slideType : slide.slideType;
  const updated = makeSlide(project.id, slide.id, slide.sortOrder, slideType, content, {
    ...slide,
    slideType,
    ...(b.imageAssetId !== undefined && {
      imageAssetId: typeof b.imageAssetId === 'string' ? b.imageAssetId : null,
    }),
    ...(b.backgroundColor !== undefined && {
      backgroundColor: typeof b.backgroundColor === 'string' ? b.backgroundColor : null,
    }),
    ...(b.transitionIn !== undefined && {
      transitionIn: typeof b.transitionIn === 'string' ? b.transitionIn : null,
    }),
    ...(typeof b.durationSec === 'number' && { durationSec: clamp(b.durationSec) }),
  });
  save(
    project.id,
    slidesFor(project.id).map((s) => (s.id === slide.id ? updated : s)),
  );
  touch(project);
  return { slide: updated };
});

route('DELETE', '/slides/:id', ({ params }) => {
  const { project, slide } = findSlide(params.id ?? '');
  assertEditable(project);
  save(
    project.id,
    slidesFor(project.id).filter((s) => s.id !== slide.id),
  );
  touch(project);
  return { deleted: true };
});

route('POST', '/slides/:id/reorder', ({ params, body }) => {
  const { project, slide } = findSlide(params.id ?? '');
  assertEditable(project);
  const target = Number((body as Record<string, unknown> | undefined)?.newSortOrder);
  if (!Number.isInteger(target) || target < 0)
    throw new DemoHttpError(400, 'validation_error', 'newSortOrder is invalid');
  const rest = slidesFor(project.id).filter((s) => s.id !== slide.id);
  const at = Math.min(target, rest.length);
  touch(project);
  return { data: save(project.id, [...rest.slice(0, at), slide, ...rest.slice(at)]) };
});

route('POST', '/projects/:id/auto-populate', async ({ params }) => {
  const p = slideshowProject(params.id ?? '');
  if (!EDITABLE.has(p.state))
    throw new DemoHttpError(
      409,
      'conflict',
      `Project is ${p.state}; auto-populate needs an editable slideshow`,
    );
  await linkLibrary(p.businessId);
  startAutoPopulate(p);
  const populate = p.metadata?.populate as { id?: string } | undefined;
  return { status: 202, body: { populateId: populate?.id ?? '' } };
});

route('GET', '/slideshow-templates', ({ query }) => {
  const category = query.get('category');
  return { data: listSlideshowTemplates().filter((t) => !category || t.category === category) };
});

route('POST', '/slideshow-templates', ({ body }) => {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) throw new DemoHttpError(400, 'validation_error', 'name is required');
  const p = slideshowProject(typeof b.projectId === 'string' ? b.projectId : '');
  const slides = slidesFor(p.id);
  if (slides.length === 0)
    throw new DemoHttpError(400, 'validation_error', 'The slideshow has no slides');
  const template = addSlideshowTemplate({
    id: newId('sst'),
    organisationId: DEMO_ORG_ID,
    name: name.slice(0, 120),
    category: 'custom',
    slidePlan: slides.map((s) => ({
      slideType: s.slideType,
      role: s.content.role,
      durationSec: s.durationSec,
    })),
    musicMood: 'upbeat',
    defaultDurationPerSlide: 3,
  });
  return { status: 201, body: { template } };
});
