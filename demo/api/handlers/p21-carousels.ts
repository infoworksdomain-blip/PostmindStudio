// 21.6 carousels (post cards) in the demo: a seeded carousel ready for review, Create → Carousel
// runs, and the editor's endpoints (services/carousels.ts shapes). Slides are drawn here as SVG
// from the real slide breakdown and layout (src/lib/studio/carousel); the live app renders them
// to PNG on the server with the bundled fonts, so the demo's text metrics are approximate.
import type { Render } from '@/lib/client/types';
import { planSlides } from '@/lib/studio/carousel/breakdown';
import { MAX_SLIDES, MAX_POSTS, THEMES, type CarouselTheme } from '@/lib/studio/carousel/constants';
import { buildSlideLayout, type SlideLayout } from '@/lib/studio/carousel/layout';
import { parsePastedThread } from '@/lib/studio/carousel/paste';
import { CAROUSEL_TARGET_FORMATS } from '@/lib/studio/carousel/publishing';
import { cleanSlideText, type MeasureText } from '@/lib/studio/carousel/text';
import type { CarouselPost } from '@/lib/studio/carousel/types';
import { isRtl } from '@/lib/studio/i18n/scripts';
import { DEMO_BUSINESS_NAME } from '../ids';
import { DemoHttpError, route } from '../registry';
import { libraryImage, libraryImages } from './business-images';
import {
  ago,
  baseProject,
  getProject,
  HOUR,
  newId,
  nowIso,
  putProject,
  setMeta,
  touch,
  type ProjectRec,
} from './projects-store';

export const CAROUSEL_PROJECT = {
  id: 'prj-bread-tips-carousel',
  name: '7 ways to keep bread fresh',
};

interface DemoPost {
  id: string;
  text: string;
  imageId: string | null;
}

interface DemoCarousel {
  theme: CarouselTheme;
  language: string;
  displayName: string;
  handle: string;
  posts: DemoPost[];
  postCount: number;
  rewrites: number;
}

const EDITABLE = new Set(['DRAFT', 'FAILED', 'REJECTED', 'QUALITY_FAILED', 'READY_FOR_REVIEW']);
const RERENDER = new Set(['FAILED', 'REJECTED', 'QUALITY_FAILED', 'READY_FOR_REVIEW']);
const MAX_REWRITES = 30;
const bad = (message: string) => new DemoHttpError(400, 'validation_error', message);

/** Inter-like widths (em) for the demo's layout; the server uses the font file's real advances. */
const measure: MeasureText = (text, fontSize, bold = false) =>
  [...text].reduce(
    (w, ch) =>
      w + (/[iljI.,:;'!|]/.test(ch) ? 0.28 : /[mwMW@]/.test(ch) ? 0.85 : ch === ' ' ? 0.28 : 0.56),
    0,
  ) *
  fontSize *
  (bold ? 1.07 : 1);

const SAMPLE_POSTS = [
  '7 ways to keep a sourdough loaf fresh for longer:',
  'Store it cut side down on a wooden board.\n\nThe crust protects the crumb, and the wood lets it breathe.',
  'Never in the fridge.\n\n→ the cold dries bread out\n→ it goes stale three times faster',
  'A cotton bread bag beats plastic.',
  'Slice only what you eat today.',
  'Freeze what you won’t finish in two days:\n\n→ slice it first\n→ toast straight from frozen',
  'Stale already? Turn it into croutons, crumbs or a bread-and-butter pudding.',
  'Save this for your next loaf, and follow for more bakery tips.',
];

function carouselOf(p: ProjectRec): DemoCarousel {
  const c = p.metadata?.carousel as DemoCarousel | undefined;
  if (p.sourceType !== 'CAROUSEL' || !c)
    throw new DemoHttpError(409, 'conflict', 'This project is not a carousel');
  return c;
}

function postsFor(c: DemoCarousel): CarouselPost[] {
  return c.posts.map((post) => {
    const image = post.imageId ? libraryImage(post.imageId) : null;
    return {
      id: post.id,
      text: cleanSlideText(post.text, () => true).text,
      image: image
        ? {
            imageId: image.id,
            width: image.widthPx,
            height: image.heightPx,
            aiGenerated: image.source === 'GENERATED',
          }
        : null,
    };
  });
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function slideSvg(layout: SlideLayout): string {
  const colours = THEMES[layout.theme];
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">`,
    `<rect width="1080" height="1350" fill="${layout.background}"/>`,
  ];
  layout.elements.forEach((el, i) => {
    if (el.type === 'divider')
      parts.push(
        `<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.thickness}" fill="${el.colour}"/>`,
      );
    else if (el.type === 'avatar') {
      const r = el.size / 2;
      parts.push(
        `<circle cx="${el.x + r}" cy="${el.y + r}" r="${r}" fill="${colours.avatarFallback}"/>`,
        `<text x="${el.x + r}" y="${el.y + r + 13}" text-anchor="middle" font-family="Inter, sans-serif" font-size="36" font-weight="700" fill="${colours.text}">${esc(el.initial)}</text>`,
      );
    } else if (el.type === 'image') {
      const href = libraryImage(el.imageId)?.previewUrl ?? '';
      parts.push(
        `<clipPath id="c${i}"><rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" rx="${el.radius}"/></clipPath>`,
        `<image href="${esc(href)}" x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" preserveAspectRatio="xMidYMid slice" clip-path="url(#c${i})"/>`,
      );
    } else {
      const anchor = el.align === 'right' ? 'end' : 'start';
      parts.push(
        `<text x="${el.x}" y="${Math.round(el.y + el.lineHeight * 0.72)}" text-anchor="${anchor}"${layout.direction === 'rtl' ? ' direction="rtl"' : ''} font-family="Inter, 'Noto Sans', 'Noto Sans Arabic', sans-serif" font-size="${el.fontSize}" font-weight="${el.bold ? 700 : 400}" fill="${el.colour}">${esc(el.text)}</text>`,
      );
    }
  });
  parts.push('</svg>');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(parts.join(''))}`;
}

function draw(c: DemoCarousel) {
  const posts = postsFor(c);
  const plans = planSlides(posts, measure).slice(0, MAX_SLIDES);
  const ctx = {
    theme: c.theme,
    direction: isRtl(c.language) ? ('rtl' as const) : ('ltr' as const),
    profile: { displayName: c.displayName, handle: c.handle, logoUploadId: null },
    measure,
  };
  return {
    posts,
    slides: plans.map((plan) => ({
      index: plan.index,
      kind: plan.kind,
      postIds: [...new Set(plan.parts.map((part) => part.postId))],
      image: slideSvg(buildSlideLayout(plan, ctx)),
    })),
  };
}

function renderOf(p: ProjectRec, c: DemoCarousel): Render & { composition: unknown } {
  const { posts, slides } = draw(c);
  return {
    id: newId('rnd'),
    projectId: p.id,
    scriptId: `${p.id}-carousel`,
    targetPlatform: 'carousel',
    aspectRatio: '4:5',
    resolution: '1080x1350',
    durationSec: 0,
    qualityCheckState: 'PASSED',
    qualityIssues: [],
    costPence: 0,
    createdAt: nowIso(),
    composition: {
      kind: 'carousel',
      version: 1,
      bucket: 'demo',
      theme: c.theme,
      language: c.language,
      aiGenerated: posts.some((post) => post.image?.aiGenerated),
      slides: slides.map((s) => ({
        index: s.index,
        pngKey: s.image,
        jpegKey: s.image,
        width: 1080,
        height: 1350,
        altText: '',
        postIds: s.postIds,
      })),
      issues: [],
    },
  };
}

function view(p: ProjectRec) {
  const c = carouselOf(p);
  const render = p.renders.find((r) => r.targetPlatform === 'carousel') as
    | (Render & {
        composition?: {
          aiGenerated: boolean;
          slides: Array<{ index: number; pngKey: string; postIds: string[] }>;
        };
      })
    | undefined;
  const posts = postsFor(c);
  return {
    projectId: p.id,
    state: p.state,
    editable: EDITABLE.has(p.state),
    canRerender: Boolean(render) && RERENDER.has(p.state),
    rewritesLeft: Math.max(0, MAX_REWRITES - c.rewrites),
    carousel: {
      theme: c.theme,
      language: c.language,
      profile: { displayName: c.displayName, handle: c.handle, logoUploadId: null },
      posts,
      postCount: c.postCount,
      aiWritten: true,
    },
    images: Object.fromEntries(
      c.posts.flatMap((post) => {
        const url = post.imageId ? libraryImage(post.imageId)?.previewUrl : null;
        return post.imageId && url ? [[post.imageId, url]] : [];
      }),
    ),
    render: render?.composition
      ? {
          id: render.id,
          qualityCheckState: render.qualityCheckState,
          createdAt: render.createdAt,
          aiGenerated: render.composition.aiGenerated,
          issues: [],
          slides: render.composition.slides.map((s) => ({
            index: s.index,
            pngUrl: s.pngKey,
            postIds: s.postIds,
          })),
        }
      : null,
  };
}

function editFrom(c: DemoCarousel, body: unknown): DemoCarousel {
  const b = (body ?? {}) as {
    theme?: unknown;
    profile?: { displayName?: unknown; handle?: unknown };
    posts?: unknown;
  };
  if (b.theme !== 'light' && b.theme !== 'dark') throw bad('theme must be light or dark');
  const name = typeof b.profile?.displayName === 'string' ? b.profile.displayName.trim() : '';
  if (!name) throw bad('profile.displayName is required');
  const handle =
    typeof b.profile?.handle === 'string' ? b.profile.handle.trim().replace(/^@/, '') : '';
  if (!Array.isArray(b.posts) || b.posts.length === 0 || b.posts.length > MAX_POSTS)
    throw bad('posts: 1 to 12');
  const posts = b.posts.map((raw) => {
    const post = (raw ?? {}) as { id?: unknown; text?: unknown; imageId?: unknown };
    if (typeof post.id !== 'string' || typeof post.text !== 'string')
      throw bad('Each post needs an id and text');
    const imageId = typeof post.imageId === 'string' ? post.imageId : null;
    if (imageId && !libraryImage(imageId))
      throw bad('Some pictures are not in this business’s image library');
    return { id: post.id, text: post.text.slice(0, 600), imageId };
  });
  return {
    ...c,
    theme: b.theme,
    displayName: name.slice(0, 50),
    handle: handle.slice(0, 30),
    posts,
  };
}

route('GET', '/projects/:id/carousel', ({ params }) => ({
  carousel: view(getProject(params.id ?? '')),
}));

route('PUT', '/projects/:id/carousel', ({ params, body }) => {
  const p = getProject(params.id ?? '');
  if (!EDITABLE.has(p.state))
    throw new DemoHttpError(
      409,
      'conflict',
      `The carousel cannot be edited while the project is ${p.state}`,
    );
  setMeta(p, { carousel: editFrom(carouselOf(p), body) });
  touch(p);
  return { carousel: view(p) };
});

route('POST', '/projects/:id/carousel/preview', ({ params, body }) => {
  const p = getProject(params.id ?? '');
  const { slides } = draw(editFrom(carouselOf(p), body));
  const hook = (body as { posts?: Array<{ imageId?: unknown }> }).posts?.[0];
  return {
    preview: {
      slides,
      issues: hook && !hook.imageId ? [{ slide: 0, code: 'hook_without_image', detail: '' }] : [],
      removedCharacters: 0,
    },
  };
});

route('POST', '/projects/:id/carousel/render', ({ params }) => {
  const p = getProject(params.id ?? '');
  if (!RERENDER.has(p.state))
    throw new DemoHttpError(
      409,
      'conflict',
      `The carousel cannot be rendered while the project is ${p.state}`,
    );
  touch(p, { state: 'RENDERING', completedAt: null, errorReason: null });
  window.setTimeout(() => {
    p.renders = [renderOf(p, carouselOf(p))];
    touch(p, { state: 'READY_FOR_REVIEW', completedAt: nowIso() });
  }, 2_500);
  return { status: 202, body: { projectId: p.id, state: 'ASSETS_QUEUED', runId: newId('run') } };
});

route('POST', '/projects/:id/carousel/rewrite', ({ params, body }) => {
  const p = getProject(params.id ?? '');
  const c = carouselOf(p);
  if (c.rewrites >= MAX_REWRITES)
    throw new DemoHttpError(429, 'rate_limited', 'This carousel has used its AI rewrites');
  const postId = (body as { postId?: unknown } | null)?.postId;
  const posts = c.posts.map((post, i) =>
    typeof postId === 'string'
      ? post.id === postId
        ? { ...post, text: SAMPLE_POSTS[(i + c.rewrites + 3) % SAMPLE_POSTS.length] ?? post.text }
        : post
      : { ...post, text: SAMPLE_POSTS[i % SAMPLE_POSTS.length] ?? post.text },
  );
  setMeta(p, { carousel: { ...c, posts, rewrites: c.rewrites + 1 } });
  touch(p);
  return { carousel: view(p) };
});

route('POST', '/projects/:id/carousel/download', ({ params }) => {
  const v = view(getProject(params.id ?? ''));
  const first = v.render?.slides[0];
  if (!first) throw new DemoHttpError(404, 'not_found', 'The carousel has not been rendered yet');
  // The demo has no ZIP: it opens the first slide (live: a signed URL of every PNG in a ZIP).
  return { url: first.pngUrl, fileName: `carousel-${params.id}.zip` };
});

/** POST /projects with sourceType CAROUSEL (demo/api/handlers/projects.ts). */
export function carouselMetadata(
  body: Record<string, unknown>,
  language: string,
): { carousel: DemoCarousel } {
  const options = (body.carousel ?? {}) as {
    theme?: unknown;
    postCount?: unknown;
    thread?: unknown;
    handle?: unknown;
  };
  const thread =
    typeof options.thread === 'string' ? parsePastedThread(options.thread, MAX_POSTS) : [];
  const count = Math.min(MAX_POSTS, Math.max(3, Number(options.postCount ?? 7) || 7));
  return {
    carousel: {
      theme: options.theme === 'dark' ? 'dark' : 'light',
      language,
      displayName: DEMO_BUSINESS_NAME,
      handle: typeof options.handle === 'string' ? options.handle : 'leedssourdough',
      posts: thread.map((text) => ({ id: newId('post'), text, imageId: null })),
      postCount: thread.length || count,
      rewrites: 0,
    },
  };
}

export const carouselFormats = () =>
  CAROUSEL_TARGET_FORMATS.map((f) => ({
    platform: f.platform,
    aspectRatio: f.aspectRatio,
    duration: f.durationSec,
  }));

/** POST /projects/:id/generate for a carousel: write (if needed), pick pictures, render. */
export function startCarouselRun(p: ProjectRec): void {
  const c = carouselOf(p);
  touch(p, { state: 'QUEUED', errorReason: null, completedAt: null });
  const steps: Array<[number, () => void]> = [
    [1.5, () => touch(p, { state: 'PLANNING' })],
    [
      4,
      () => {
        const pictures = libraryImages().slice(0, 3);
        const posts =
          c.posts.length > 0
            ? c.posts
            : SAMPLE_POSTS.slice(0, c.postCount - 1)
                .concat(SAMPLE_POSTS[SAMPLE_POSTS.length - 1] ?? '')
                .map((text) => ({ id: newId('post'), text, imageId: null as string | null }));
        const withPictures = posts.map((post, i) =>
          i === 0 && !post.imageId ? { ...post, imageId: pictures[0]?.id ?? null } : post,
        );
        setMeta(p, { carousel: { ...c, posts: withPictures } });
        touch(p, { state: 'ASSETS_QUEUED', costActualPence: p.costActualPence + 9 });
      },
    ],
    [5.5, () => touch(p, { state: 'RENDERING' })],
    [7.5, () => touch(p, { state: 'QUALITY_CHECKING' })],
    [
      9,
      () => {
        p.renders = [renderOf(p, carouselOf(p))];
        touch(p, { state: 'READY_FOR_REVIEW', completedAt: nowIso() });
      },
    ],
  ];
  for (const [sec, step] of steps) window.setTimeout(step, sec * 1_000);
}

/** The seeded carousel: written, pictured, rendered and waiting for review. */
export function seedCarousel(): void {
  const p = baseProject(CAROUSEL_PROJECT.id, CAROUSEL_PROJECT.name, {
    state: 'READY_FOR_REVIEW',
    sourceType: 'CAROUSEL',
    scene: 'sourdough',
    description:
      'Tips for keeping a sourdough loaf fresh, as a carousel for Instagram and LinkedIn.',
    targetFormats: carouselFormats(),
    costActualPence: 21,
    createdAt: ago(5 * HOUR),
    updatedAt: ago(4 * HOUR),
    completedAt: ago(4 * HOUR),
  });
  const pictures = libraryImages();
  setMeta(p, {
    carousel: {
      theme: 'light',
      language: 'en-GB',
      displayName: DEMO_BUSINESS_NAME,
      handle: 'leedssourdough',
      posts: SAMPLE_POSTS.map((text, i) => ({
        id: `post-${i + 1}`,
        text,
        imageId: i === 0 ? (pictures[0]?.id ?? null) : i === 5 ? (pictures[1]?.id ?? null) : null,
      })),
      postCount: SAMPLE_POSTS.length,
      rewrites: 2,
    } satisfies DemoCarousel,
  });
  p.renders = [{ ...renderOf(p, carouselOf(p)), createdAt: ago(4 * HOUR) }];
  putProject(p);
}

seedCarousel();
