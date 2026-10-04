// Client model of the carousel editor (21.6): the API's shapes and pure draft operations, so the
// editing rules are unit-tested without rendering the screen.
import { parseParagraphs } from '@/lib/studio/carousel/text';

export type CarouselTheme = 'light' | 'dark';

export interface CarouselImageRecord {
  imageId: string;
  width: number;
  height: number;
  aiGenerated: boolean;
}

export interface StoredPost {
  id: string;
  text: string;
  image: CarouselImageRecord | null;
  imageQuery?: string;
}

export interface CarouselIssue {
  slide: number;
  code: string;
  detail: string;
}

/** GET /projects/:id/carousel → carousel (services/carousels.ts CarouselView). */
export interface CarouselView {
  projectId: string;
  state: string;
  editable: boolean;
  canRerender: boolean;
  rewritesLeft: number;
  carousel: {
    theme: CarouselTheme;
    language: string;
    profile: { displayName: string; handle: string; logoUploadId: string | null };
    posts: StoredPost[];
    postCount: number;
    aiWritten: boolean;
  };
  images: Record<string, string>;
  render: {
    id: string;
    qualityCheckState: string;
    createdAt: string;
    aiGenerated: boolean;
    issues: CarouselIssue[];
    slides: Array<{ index: number; pngUrl: string; postIds: string[] }>;
  } | null;
}

export interface PreviewSlide {
  index: number;
  kind: 'single' | 'pair';
  postIds: string[];
  image: string;
}

export interface CarouselPreview {
  slides: PreviewSlide[];
  issues: CarouselIssue[];
  removedCharacters: number;
}

export interface DraftPost {
  id: string;
  text: string;
  imageId: string | null;
}

export interface CarouselDraft {
  theme: CarouselTheme;
  displayName: string;
  handle: string;
  posts: DraftPost[];
}

export const MAX_POSTS = 12;
export const MAX_POST_CHARS = 600;

export function draftFromView(view: CarouselView): CarouselDraft {
  return {
    theme: view.carousel.theme,
    displayName: view.carousel.profile.displayName,
    handle: view.carousel.profile.handle,
    posts: view.carousel.posts.map((p) => ({
      id: p.id,
      text: p.text,
      imageId: p.image?.imageId ?? null,
    })),
  };
}

/** The PUT /carousel and POST /carousel/preview body. */
export function editBody(draft: CarouselDraft) {
  return {
    theme: draft.theme,
    profile: { displayName: draft.displayName.trim(), handle: draft.handle.trim() },
    posts: draft.posts.map((p) => ({ id: p.id, text: p.text, imageId: p.imageId })),
  };
}

export function sameDraft(a: CarouselDraft, b: CarouselDraft): boolean {
  return JSON.stringify(editBody(a)) === JSON.stringify(editBody(b));
}

/** Move a post one place up (-1) or down (+1); unchanged at either end. */
export function movePost(draft: CarouselDraft, id: string, by: -1 | 1): CarouselDraft {
  const from = draft.posts.findIndex((p) => p.id === id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= draft.posts.length) return draft;
  const posts = [...draft.posts];
  const [moved] = posts.splice(from, 1);
  if (!moved) return draft;
  posts.splice(to, 0, moved);
  return { ...draft, posts };
}

export function updatePost(
  draft: CarouselDraft,
  id: string,
  patch: Partial<DraftPost>,
): CarouselDraft {
  return { ...draft, posts: draft.posts.map((p) => (p.id === id ? { ...p, ...patch } : p)) };
}

export function removePost(draft: CarouselDraft, id: string): CarouselDraft {
  if (draft.posts.length <= 1) return draft;
  return { ...draft, posts: draft.posts.filter((p) => p.id !== id) };
}

/** Add an empty post before the call to action (or at the end of a one-post thread). */
export function addPost(draft: CarouselDraft, id: string): CarouselDraft {
  if (draft.posts.length >= MAX_POSTS) return draft;
  const posts = [...draft.posts];
  const at = posts.length > 1 ? posts.length - 1 : posts.length;
  posts.splice(at, 0, { id, text: '', imageId: null });
  return { ...draft, posts };
}

export type PostRole = 'hook' | 'body' | 'cta';

export function roleOf(index: number, count: number): PostRole {
  if (index === 0) return 'hook';
  if (index === count - 1 && count > 1) return 'cta';
  return 'body';
}

/** 1-based numbers of the slides a post appears on. */
export function slidesOfPost(
  slides: readonly { index: number; postIds: string[] }[],
  id: string,
): number[] {
  return slides.filter((s) => s.postIds.includes(id)).map((s) => s.index + 1);
}

/** True when the text has a list of two or more bullet lines (the waterfall sort applies). */
export function hasList(text: string): boolean {
  return parseParagraphs(text).some((para) => para.filter((line) => line.bullet).length >= 2);
}

/** The "shortest line first" list order (the same helper the server uses). */
export { waterfallBullets as waterfall } from '@/lib/studio/carousel/waterfall';
