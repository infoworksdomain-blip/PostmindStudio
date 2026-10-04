import type { CarouselTheme } from './constants';

/** An image placed on a post (from the business image library, an upload or AI generation). */
export interface CarouselImage {
  /** studio.image_library id. */
  readonly imageId: string;
  readonly width: number;
  readonly height: number;
  readonly aiGenerated: boolean;
}

/** One post of the thread. The first post is the hook; the last is the call to action. */
export interface CarouselPost {
  readonly id: string;
  readonly text: string;
  readonly image: CarouselImage | null;
}

export interface CarouselProfile {
  readonly displayName: string;
  /** Without the leading @. Empty hides the handle. */
  readonly handle: string;
  /** The brand kit logo (studio.video_uploads BRAND_LOGO id), or null for an initial on a circle. */
  readonly logoUploadId: string | null;
}

/** The carousel as stored on the project (project.metadata.carousel). */
export interface CarouselDocument {
  readonly version: 1;
  readonly theme: CarouselTheme;
  readonly language: string;
  readonly profile: CarouselProfile;
  readonly posts: readonly CarouselPost[];
}

/** A piece of a post placed on a slide (long posts become several parts). */
export interface SlidePart {
  readonly postId: string;
  readonly text: string;
  readonly image: CarouselImage | null;
  /** 0 for the first part of a post, 1.. for continuation slides. */
  readonly partIndex: number;
}

export type SlideKind = 'single' | 'pair';

export interface SlidePlan {
  readonly index: number;
  readonly kind: SlideKind;
  readonly parts: readonly SlidePart[];
  /** Body text size chosen for the slide (px). */
  readonly fontSize: number;
}
