// Pictures for a carousel's posts, chosen by meaning (21.6), the way slideshows fill theirs
// (slideshow/populate.ts, 20.26): the business's image library (pgvector search on the post's
// image query), then stock photos (Pixabay, then Unsplash), then an AI-generated image within the
// slideshow generation budget. No new provider or key. The hook always asks for a picture; other
// posts only when the writer gave an image query. A post that still has none keeps its text.
import type { ImageLibraryItem } from '@prisma/client';
import {
  generatedImage,
  generationBudget,
  libraryMatch,
  type PopulateDeps,
  type PopulateScope,
} from '../slideshow/populate';
import { embedNewImages, stockImageForSlide } from '../slideshow/slide-images';
import { carouselImages } from './assets';
import type { StoredPost } from './document';

/** Landscape pictures read best under a post (the skill prefers landscape or square). */
const PICTURE_ASPECT = '16:9';

export interface PictureResult {
  readonly posts: StoredPost[];
  readonly matched: number;
  readonly stocked: number;
  readonly generated: number;
}

function queryFor(post: StoredPost, index: number): string | undefined {
  const query = post.imageQuery?.trim();
  if (query) return query;
  // The hook always gets a picture: its own words are the query when the writer gave none.
  return index === 0 && post.text.trim() ? post.text.trim().slice(0, 200) : undefined;
}

async function pick(
  deps: PopulateDeps,
  scope: PopulateScope,
  query: string,
  used: Set<string>,
  canGenerate: boolean,
): Promise<{ id: string; how: 'matched' | 'stocked' | 'generated' } | null> {
  const matched = await libraryMatch(deps, scope, { query, used, bestEffort: true });
  if (matched) return { id: matched, how: 'matched' };
  const stock = await stockImageForSlide(deps.library, scope, {
    query,
    aspectRatio: PICTURE_ASPECT,
    exclude: new Set(used),
  });
  if (stock) return { id: stock.id, how: 'stocked' };
  if (!canGenerate) return null;
  const generated = await generatedImage(deps, scope, {
    query,
    aspectRatio: PICTURE_ASPECT,
    bestEffort: true,
  });
  return generated ? { id: generated, how: 'generated' } : null;
}

/** Fill the posts that want a picture and have none; returns new post records. */
export async function fillCarouselPictures(
  deps: PopulateDeps,
  scope: PopulateScope,
  posts: readonly StoredPost[],
): Promise<PictureResult> {
  const used = new Set(posts.flatMap((p) => (p.image ? [p.image.imageId] : [])));
  const budget = await generationBudget(deps, scope);
  const chosen = new Map<number, string>();
  let matched = 0;
  let stocked = 0;
  let generated = 0;
  for (const [index, post] of posts.entries()) {
    const query = post.image ? undefined : queryFor(post, index);
    if (!query) continue;
    const hit = await pick(deps, scope, query, used, generated < budget);
    if (!hit) continue;
    used.add(hit.id);
    chosen.set(index, hit.id);
    if (hit.how === 'matched') matched += 1;
    else if (hit.how === 'stocked') stocked += 1;
    else generated += 1;
  }
  if (chosen.size === 0) return { posts: [...posts], matched, stocked, generated };
  if (stocked > 0) await embedNewImages(deps.library, scope);
  const records = await carouselImages(deps.db, scope, [...chosen.values()]);
  for (const id of chosen.values()) {
    const item: ImageLibraryItem = await deps.db.imageLibraryItem.update({
      where: { id },
      data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
    });
    await deps.reportStockUse(item);
  }
  return {
    posts: posts.map((post, index) => {
      const id = chosen.get(index);
      return id ? { ...post, image: records.get(id) ?? null } : post;
    }),
    matched,
    stocked,
    generated,
  };
}
