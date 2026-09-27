// Image library (services/image-library.ts): list by source/tag with cursor pages, semantic
// search (similarity scores), multipart upload, generate from a prompt, stock refresh, delete.
// Previews are drawn by demo/media.ts; uploads keep the picked file as a blob: URL.
import type { LibraryImage } from '@/components/studio/business/types';
import { sceneImage, type SceneKind } from '../../media';
import { DEMO_BUSINESS_ID } from '../ids';
import { DemoHttpError, route } from '../registry';
import {
  GENERATED,
  type ImageSeed,
  REFRESH_STOCK,
  SCRAPED,
  SITE,
  STOCK,
  UPLOAD,
} from './business-images-seed';
import { getProfile } from './business-profile';

type StoredImage = Omit<LibraryImage, 'previewUrl' | 'similarity'> & {
  scene: SceneKind;
  blobUrl?: string;
};

const DAY = 86_400_000;
const LOADED_AT = Date.now();
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const bad = (message: string) => new DemoHttpError(400, 'validation_error', message);

let seq = 0;
const nextId = () =>
  `img-${(++seq).toString().padStart(3, '0')}-${Math.random().toString(36).slice(2, 7)}`;

const LICENCE: Record<string, string> = {
  pexels: 'Pexels License: free for commercial use, no attribution required',
  storyblocks: 'Storyblocks Business licence (organisation subscription)',
  'dalle-3': 'Generated with DALL·E 3 for this business; no third-party rights',
};

function fromSeed(s: ImageSeed, createdAt: number): StoredImage {
  const provider =
    s.source === 'STOCK'
      ? (s.ref?.split(':')[0] ?? 'pexels')
      : s.source === 'GENERATED'
        ? 'dalle-3'
        : s.source === 'SCRAPED'
          ? 'website'
          : null;
  const w = s.w ?? 1600;
  const h = s.h ?? 1600;
  return {
    id: nextId(),
    businessId: DEMO_BUSINESS_ID,
    source: s.source,
    sourceUrl:
      s.source === 'SCRAPED'
        ? `${SITE}${s.ref ?? '/'}`
        : s.source === 'STOCK' && s.ref?.startsWith('pexels:')
          ? `https://www.pexels.com/photo/${s.ref.slice(7)}/`
          : null,
    sourceProvider: provider,
    publicUrl: null,
    hotlinked: false,
    widthPx: w,
    heightPx: h,
    fileSizeBytes: Math.round(w * h * 0.21),
    tags: s.tags.map((t) => t.toLowerCase()),
    altText: s.alt,
    generatedFromPrompt: s.source === 'GENERATED' ? (s.ref ?? null) : null,
    licenseNotes:
      s.source === 'SCRAPED'
        ? 'From your website (ownership confirmed when the scan started)'
        : provider
          ? (LICENCE[provider] ?? null)
          : null,
    useCount: s.uses ?? 0,
    createdAt: new Date(createdAt).toISOString(),
    scene: s.scene,
  };
}

const images: StoredImage[] = [
  ...SCRAPED.map((s, i) => fromSeed(s, LOADED_AT - 21 * DAY + i * 60_000)),
  ...STOCK.map((s, i) => fromSeed(s, LOADED_AT - 21 * DAY + 3_600_000 + i * 60_000)),
  ...GENERATED.map((s, i) => fromSeed(s, LOADED_AT - (14 - i * 2) * DAY)),
  ...UPLOAD.map((s, i) => fromSeed(s, LOADED_AT - (30 - i * 5) * DAY)),
];

function present(img: StoredImage): LibraryImage {
  const { scene, blobUrl, ...rest } = img;
  const long = 420;
  const scale = long / Math.max(img.widthPx, img.heightPx);
  const previewUrl =
    blobUrl ?? sceneImage(scene, Math.round(img.widthPx * scale), Math.round(img.heightPx * scale));
  return { ...rest, tags: [...rest.tags], previewUrl: previewUrl || null };
}

const newestFirst = (a: StoredImage, b: StoredImage) =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

/** Adds library images (used by a finished website scan). Returns how many were new. */
export function addLibraryImages(seeds: ImageSeed[]): number {
  let added = 0;
  for (const s of seeds) {
    if (images.some((i) => i.altText === s.alt)) continue;
    images.push(fromSeed(s, Date.now() + added));
    added += 1;
  }
  return added;
}

/** Library size per source for a business (GET /scans/:id). */
export function librarySizeBySource(businessId: string): Partial<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const i of images) if (i.businessId === businessId) out[i.source] = (out[i.source] ?? 0) + 1;
  return out;
}

function requireBusiness(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128)
    throw bad('businessId must be 1-128 characters');
  return value.trim();
}

route('GET', '/image-library', ({ query }) => {
  const businessId = requireBusiness(query.get('businessId'));
  const source = query.get('source')?.toUpperCase();
  if (source && !['SCRAPED', 'STOCK', 'GENERATED', 'UPLOAD'].includes(source))
    throw bad('source: Invalid option');
  const tag = query.get('tag')?.trim().toLowerCase();
  const limit = Math.min(100, Math.max(1, Number(query.get('limit') ?? 30) || 30));
  const all = images
    .filter(
      (i) =>
        i.businessId === businessId &&
        (!source || i.source === source) &&
        (!tag || i.tags.includes(tag)),
    )
    .sort(newestFirst);
  const cursor = query.get('cursor');
  const start = cursor ? all.findIndex((i) => i.id === cursor) + 1 : 0;
  const rows = all.slice(start, start + limit + 1);
  const page = rows.slice(0, limit);
  return {
    data: page.map(present),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
});

function find(id: string): StoredImage {
  const img = images.find((i) => i.id === id);
  if (!img) throw new DemoHttpError(404, 'not_found', 'Image not found');
  return img;
}

route('GET', '/image-library/:id', ({ params }) => ({ image: present(find(params.id ?? '')) }));

route('DELETE', '/image-library/:id', ({ params }) => {
  const img = find(params.id ?? '');
  images.splice(images.indexOf(img), 1);
  return { deleted: true };
});

const STOP = new Set([
  'the',
  'and',
  'with',
  'for',
  'our',
  'from',
  'that',
  'this',
  'image',
  'photo',
  'picture',
]);
const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
/** A stable 0–1 number per id, so scores don't jump between identical searches. */
const wobble = (id: string) =>
  ([...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 997, 7) % 100) / 100;

route('POST', '/image-library/search', ({ body }) => {
  const input = (body ?? {}) as { businessId?: unknown; query?: unknown; limit?: unknown };
  const businessId = requireBusiness(input.businessId);
  if (typeof input.query !== 'string' || !input.query.trim()) throw bad('query: Too small');
  const limit = typeof input.limit === 'number' ? Math.min(50, Math.max(1, input.limit)) : 12;
  const terms = words(input.query);
  const scored = images
    .filter((i) => i.businessId === businessId)
    .map((img) => {
      const tagWords = words(img.tags.join(' '));
      const altWords = words(img.altText ?? '');
      const hits = terms.reduce(
        (n, t) =>
          n +
          (tagWords.some((w) => w.startsWith(t) || t.startsWith(w)) ? 2 : 0) +
          (altWords.some((w) => w.startsWith(t) || t.startsWith(w)) ? 1 : 0),
        0,
      );
      const strength = terms.length ? Math.min(1, hits / (terms.length * 2)) : 0;
      const similarity = Math.min(0.97, 0.22 + strength * 0.62 + wobble(img.id) * 0.12);
      return { img, similarity: Math.round(similarity * 1000) / 1000 };
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
  return { data: scored.map(({ img, similarity }) => ({ ...present(img), similarity })) };
});

function imageSize(file: File): Promise<{ w: number; h: number } | null> {
  if (typeof createImageBitmap !== 'function') return Promise.resolve(null);
  return createImageBitmap(file).then(
    (bmp) => {
      const size = { w: bmp.width, h: bmp.height };
      bmp.close();
      return size;
    },
    () => null,
  );
}

route('POST', '/image-library', async ({ body }) => {
  if (!(body instanceof FormData)) throw bad('Upload must be multipart/form-data');
  const businessId = requireBusiness(body.get('businessId'));
  const file = body.get('file');
  if (!(file instanceof File)) throw bad('file is required');
  if (file.size > MAX_IMAGE_BYTES) throw bad('Image is larger than 15 MB');
  if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(file.type))
    throw bad('File is not a supported image (JPEG, PNG, WebP, GIF or AVIF)');
  const size = await imageSize(file);
  if (!size) throw bad('File is not a supported image (JPEG, PNG, WebP, GIF or AVIF)');
  if (Math.max(size.w, size.h) < 500)
    throw bad('Image is too small (the long edge must be at least 500px)');
  const same = images.find(
    (i) => i.source === 'UPLOAD' && i.fileSizeBytes === file.size && i.altText === file.name,
  );
  if (same) return { status: 200, body: { duplicate: true, image: present(same) } };
  const tagsField = body.get('tags');
  const img: StoredImage = {
    ...fromSeed(
      {
        source: 'UPLOAD',
        scene: 'flatlay',
        tags:
          typeof tagsField === 'string'
            ? tagsField
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)
            : [],
        alt: file.name,
        w: size.w,
        h: size.h,
      },
      Date.now(),
    ),
    businessId,
    fileSizeBytes: file.size,
    blobUrl: URL.createObjectURL(file),
  };
  images.push(img);
  return { status: 201, body: { duplicate: false, image: present(img) } };
});

const SCENE_WORDS: Array<[RegExp, SceneKind]> = [
  [/croissant|pastr|bun|nata|danish/i, 'croissant'],
  [/coffee|latte|espresso|flat white|cafe|café/i, 'coffee'],
  [/cake|dessert|birthday|wedding|stollen|mince/i, 'cake'],
  [/shop|store|window|front|street/i, 'storefront'],
  [/baker|chef|team|portrait|people/i, 'baker'],
  [/market|stall|festival|event/i, 'market'],
  [/kitchen|oven|bakehouse|dough|flour/i, 'kitchen'],
  [/flat ?lay|table|spread|overhead/i, 'flatlay'],
  [/title|card|background|minimal/i, 'studio'],
];
const ASPECT_SIZE: Record<string, [number, number]> = {
  '1:1': [1024, 1024],
  '9:16': [1024, 1792],
  '16:9': [1792, 1024],
  '4:5': [1024, 1280],
};

route('POST', '/image-library/generate', async ({ body }) => {
  const input = (body ?? {}) as {
    businessId?: unknown;
    prompt?: unknown;
    style?: unknown;
    aspectRatio?: unknown;
  };
  const businessId = requireBusiness(input.businessId);
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (prompt.length < 3) throw bad('prompt: Too small: expected string to have >=3 characters');
  const style = typeof input.style === 'string' && input.style.trim() ? input.style.trim() : null;
  const aspect =
    typeof input.aspectRatio === 'string' && input.aspectRatio in ASPECT_SIZE
      ? input.aspectRatio
      : '1:1';
  const [w, h] = ASPECT_SIZE[aspect] ?? [1024, 1024];
  await new Promise((r) => setTimeout(r, 2_200));
  const scene = SCENE_WORDS.find(([re]) => re.test(prompt))?.[1] ?? 'sourdough';
  const img: StoredImage = {
    ...fromSeed(
      {
        source: 'GENERATED',
        scene,
        tags: [...new Set(words(prompt))].slice(0, 4),
        alt: prompt.length > 90 ? `${prompt.slice(0, 87)}…` : prompt,
        ref: style ? `${prompt}. Style: ${style}` : prompt,
        w,
        h,
      },
      Date.now(),
    ),
    businessId,
  };
  images.push(img);
  return { status: 201, body: { duplicate: false, image: present(img) } };
});

route('POST', '/image-library/refresh', ({ body }) => {
  const input = (body ?? {}) as { businessId?: unknown; queries?: unknown };
  const businessId = requireBusiness(input.businessId);
  const given = Array.isArray(input.queries)
    ? input.queries.filter((q): q is string => typeof q === 'string')
    : [];
  const queries = given.length ? given : (getProfile(businessId)?.imageSearchQueries ?? []);
  if (!queries.length) throw bad('No search queries: scan the website first or pass queries');
  setTimeout(() => addLibraryImages(REFRESH_STOCK), 4_000);
  return { status: 202, body: { queued: true, queries } };
});
