// /library/* (agent "insight"): browse with taxonomy filters and cursor pagination, detail with a
// short-lived preview clip, blueprint (TEMPLATE) / style signature (INSPIRE), similar and
// recommended shelves. Staff edits and retirements (admin-library.ts) change what these return.
import { sampleVideo, sceneImage } from '../../media';
import { DEMO_BUSINESS_ID } from '../ids';
import { DemoHttpError, route } from '../registry';
import {
  allowedModesFor,
  CATEGORY_TREE,
  categoryName,
  shotsFor,
  STRUCTURE_TRANSITIONS,
  type LibraryItem,
} from './library-data';
import { libraryItems, liveItem } from './library-store';

const THUMB_W = 360;
const THUMB_H = 560;
const PREVIEW_TTL_SEC = 600;

function present(item: LibraryItem) {
  const a = item.analysis;
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    tags: [...item.tags],
    durationSec: item.durationSec,
    aspectRatio: item.aspectRatio,
    sourcePlatform: item.sourcePlatform,
    category: {
      slug: item.categorySlug,
      name: categoryName(item.categorySlug) ?? item.categorySlug,
    },
    analysis: {
      paceTag: a.paceTag,
      moodTag: a.moodTag,
      structurePattern: a.structurePattern,
      shotCount: shotsFor(a.structurePattern, item.durationSec, a.hook).length,
    },
    allowedModes: allowedModesFor(item.scenario),
    thumbnailUrl: sceneImage(item.scene, THUMB_W, THUMB_H),
  };
}

function previewClip(item: LibraryItem): Promise<string> {
  return sampleVideo({
    scene: item.scene,
    aspect: '9:16',
    seconds: 3,
    caption: item.analysis.hook,
  });
}

function numberParam(q: URLSearchParams, key: string): number | undefined {
  const raw = q.get(key);
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

route('GET', '/library/categories', () => ({ data: CATEGORY_TREE }));

route('GET', '/library/videos', ({ query }) => {
  const category = query.get('category')?.trim();
  const tags = (query.get('tags') ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const mood = query.get('mood')?.trim().toLowerCase();
  const min = numberParam(query, 'durationMin');
  const max = numberParam(query, 'durationMax');
  const limit = Math.min(100, Math.max(1, numberParam(query, 'limit') ?? 24));
  const cursor = query.get('cursor');

  const rows = libraryItems()
    .filter((v) => !category || v.categorySlug.startsWith(category))
    .filter((v) => tags.every((t) => v.tags.includes(t)))
    .filter((v) => !mood || v.analysis.moodTag.toLowerCase().includes(mood))
    .filter(
      (v) =>
        (min === undefined || v.durationSec >= min) && (max === undefined || v.durationSec <= max),
    )
    .sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt) || b.id.localeCompare(a.id));
  const start = cursor ? rows.findIndex((r) => r.id === cursor) + 1 : 0;
  const page = rows.slice(start, start + limit);
  const more = rows.length > start + limit;
  return { data: page.map(present), nextCursor: more ? (page.at(-1)?.id ?? null) : null };
});

route('GET', '/library/videos/:id', async ({ params }) => {
  const item = liveItem(params.id ?? '');
  if (!item) throw new DemoHttpError(404, 'not_found', 'Library video not found');
  const shots = shotsFor(item.analysis.structurePattern, item.durationSec, item.analysis.hook);
  const a = item.analysis;
  return {
    video: {
      id: item.id,
      title: item.title,
      description: item.description,
      tags: [...item.tags],
      durationSec: item.durationSec,
      aspectRatio: item.aspectRatio,
      sourcePlatform: item.sourcePlatform,
      ingestedAt: item.ingestedAt,
      category: {
        slug: item.categorySlug,
        name: categoryName(item.categorySlug) ?? item.categorySlug,
      },
      analysis: {
        shotCount: shots.length,
        shots,
        hookPattern: a.hookPattern,
        structurePattern: a.structurePattern,
        ctaPattern: a.ctaPattern,
        paceTag: a.paceTag,
        moodTag: a.moodTag,
      },
      allowedModes: allowedModesFor(item.scenario),
      thumbnailUrl: sceneImage(item.scene, THUMB_W, THUMB_H),
      previewUrl: await previewClip(item),
      previewExpiresInSec: PREVIEW_TTL_SEC,
    },
  };
});

route('GET', '/library/blueprint/:libraryVideoId', ({ params }) => {
  const item = liveItem(params.libraryVideoId ?? '');
  if (!item) throw new DemoHttpError(404, 'not_found', 'Library video not found');
  const a = item.analysis;
  const modes = allowedModesFor(item.scenario);
  const shots = shotsFor(a.structurePattern, item.durationSec, a.hook).map((s) => ({
    durationSec: Math.round((s.endSec - s.startSec) * 100) / 100,
    type: s.type,
    overlayStyle: s.overlayStyle,
    voiceoverPresent: s.voiceoverPresent,
    hasOnScreenText: s.onScreenText.length > 0,
  }));
  return {
    libraryVideoId: item.id,
    allowedModes: modes,
    blueprint: modes.includes('TEMPLATE')
      ? {
          shotCount: shots.length,
          totalDurationSec: Math.round(shots.reduce((t, s) => t + s.durationSec, 0) * 100) / 100,
          shots,
          musicEnvelope: { bpm: a.bpm, energy: a.energy, moodTag: a.musicGenreTag },
          transitionSequence: STRUCTURE_TRANSITIONS(a.structurePattern),
          hookPattern: a.hookPattern,
          structurePattern: a.structurePattern,
          ctaPattern: a.ctaPattern,
          paceTag: a.paceTag,
        }
      : null,
    styleSignature: {
      paceTag: a.paceTag,
      moodTag: a.moodTag,
      structurePattern: a.structurePattern,
      musicGenreTag: a.musicGenreTag,
    },
  };
});

/** Deterministic "embedding" similarity from shared category path, structure, pace, mood, tags. */
function similarity(a: LibraryItem, b: LibraryItem): number {
  const pa = a.categorySlug.split('/');
  const pb = b.categorySlug.split('/');
  let depth = 0;
  while (depth < pa.length && pa[depth] === pb[depth]) depth += 1;
  const shared = a.tags.filter((t) => b.tags.includes(t)).length;
  const score =
    0.42 +
    depth * 0.07 +
    (a.analysis.structurePattern === b.analysis.structurePattern ? 0.14 : 0) +
    (a.analysis.paceTag === b.analysis.paceTag ? 0.06 : 0) +
    (a.analysis.moodTag === b.analysis.moodTag ? 0.05 : 0) +
    shared * 0.05;
  return Math.min(0.97, Math.round(score * 1000) / 1000);
}

route('POST', '/library/videos/:id/similar', ({ params, body }) => {
  const item = liveItem(params.id ?? '');
  if (!item) throw new DemoHttpError(404, 'not_found', 'Library video not found');
  const limit = (body as { limit?: number } | undefined)?.limit ?? 12;
  const data = libraryItems()
    .filter((v) => v.id !== item.id)
    .map((v) => ({ v, s: similarity(item, v) }))
    .sort((x, y) => y.s - x.s)
    .slice(0, limit)
    .map(({ v, s }) => ({ ...present(v), similarity: s }));
  return { data };
});

/** Leeds Sourdough's profile: a bakery-café selling loaves, pastries, classes and wholesale. */
const PROFILE_TAGS = [
  'bakery',
  'sourdough',
  'croissant',
  'pastry',
  'cafe',
  'coffee',
  'baking',
  'leeds',
  'launch',
  'limited drop',
  'customers',
  'team',
  'recipe',
];

route('GET', '/library/recommended', ({ query }) => {
  const businessId = query.get('businessId') ?? '';
  if (businessId !== DEMO_BUSINESS_ID)
    throw new DemoHttpError(404, 'not_found', 'No business profile yet — scan your website first');
  const category = query.get('category')?.trim();
  const limit = Math.min(50, Math.max(1, numberParam(query, 'limit') ?? 12));
  const data = libraryItems()
    .filter((v) => !category || v.categorySlug.startsWith(category))
    .map((v) => {
      const hits = v.tags.filter((t) => PROFILE_TAGS.includes(t)).length;
      const local = v.categorySlug.startsWith('business/local-business') ? 0.08 : 0;
      return { v, s: Math.min(0.96, Math.round((0.5 + hits * 0.09 + local) * 1000) / 1000) };
    })
    .sort((x, y) => y.s - x.s)
    .slice(0, limit)
    .map(({ v, s }) => ({ ...present(v), similarity: s }));
  return { data };
});
