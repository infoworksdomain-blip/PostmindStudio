// The stored carousel (project.metadata.carousel) and the editor's input, validated (21.6).
import { z } from 'zod';
import {
  MAX_HANDLE_CHARS,
  MAX_NAME_CHARS,
  MAX_POST_CHARS,
  MAX_POSTS,
  MIN_POSTS,
  DEFAULT_POSTS,
} from './constants';
import type { CarouselDocument } from './types';

const themeInput = z.enum(['light', 'dark']);

/** Instagram-style handle characters; the leading @ is dropped. */
export const handleInput = z
  .string()
  .trim()
  .max(MAX_HANDLE_CHARS + 1)
  .transform((v) => v.replace(/^@/, ''))
  .refine((v) => v === '' || /^[\p{L}\p{N}._-]{1,30}$/u.test(v), {
    message: 'A handle has letters, numbers, dots, dashes and underscores only',
  });

const imageRecord = z.object({
  imageId: z.string().min(1).max(64),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  aiGenerated: z.boolean(),
});

const storedPost = z.object({
  id: z.string().min(1).max(64),
  text: z.string().max(MAX_POST_CHARS),
  image: imageRecord.nullable(),
  /** What the writer asked a picture to show (kept for "find another picture"). */
  imageQuery: z.string().max(300).optional(),
});

export const storedCarousel = z.object({
  version: z.literal(1),
  theme: themeInput,
  language: z.string().min(2).max(20),
  profile: z.object({
    displayName: z.string().max(MAX_NAME_CHARS),
    handle: z.string().max(MAX_HANDLE_CHARS),
    logoUploadId: z.string().max(512).nullable(),
  }),
  posts: z.array(storedPost).max(MAX_POSTS),
  /** Create options: how many posts to write, and the brief, until the thread exists. */
  postCount: z.number().int().min(MIN_POSTS).max(MAX_POSTS).default(DEFAULT_POSTS),
  /** True once Studio (not the owner) wrote any post: the thread is AI-written text. */
  aiWritten: z.boolean().default(false),
  rewrites: z.number().int().min(0).default(0),
});

export type StoredCarousel = z.infer<typeof storedCarousel>;
export type StoredPost = z.infer<typeof storedPost>;

/** The stored carousel of a project's metadata, or null when it has none / it is malformed. */
export function readCarousel(metadata: unknown): StoredCarousel | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const parsed = storedCarousel.safeParse((metadata as Record<string, unknown>).carousel);
  return parsed.success ? parsed.data : null;
}

/** The renderable view of a stored carousel. */
export function toDocument(stored: StoredCarousel): CarouselDocument {
  return {
    version: 1,
    theme: stored.theme,
    language: stored.language,
    profile: stored.profile,
    posts: stored.posts.map((p) => ({ id: p.id, text: p.text, image: p.image })),
  };
}

/** POST /projects create options for a CAROUSEL project. */
export const carouselCreateInput = z
  .object({
    theme: themeInput.default('light'),
    postCount: z.number().int().min(MIN_POSTS).max(MAX_POSTS).default(DEFAULT_POSTS),
    /** A thread the owner already wrote (else Studio writes one from the brief). */
    thread: z
      .string()
      .trim()
      .max(MAX_POSTS * MAX_POST_CHARS)
      .optional(),
    handle: handleInput.optional(),
  })
  .strict();

export type CarouselCreateInput = z.infer<typeof carouselCreateInput>;

/** PUT /projects/:id/carousel (and the preview body): the editor's whole carousel. */
export const carouselEditInput = z
  .object({
    theme: themeInput,
    profile: z.object({
      displayName: z.string().trim().min(1).max(MAX_NAME_CHARS),
      handle: handleInput,
    }),
    posts: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(64),
          text: z.string().max(MAX_POST_CHARS),
          imageId: z.string().trim().min(1).max(64).nullable(),
        }),
      )
      .min(1)
      .max(MAX_POSTS),
  })
  .strict()
  .refine((v) => new Set(v.posts.map((p) => p.id)).size === v.posts.length, {
    message: 'Post ids must be unique',
  });

export type CarouselEditInput = z.infer<typeof carouselEditInput>;
