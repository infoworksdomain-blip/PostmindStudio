// Response shapes for slideshow endpoints (services/slideshows.ts, slideshow/planner.ts).

export const SLIDE_TYPES = [
  'IMAGE_STILL',
  'IMAGE_KENBURNS',
  'VIDEO_CLIP',
  'TEXT_CARD',
  'BEFORE_AFTER',
  'QUOTE',
  'STATISTIC',
  'PRODUCT',
] as const;
export type SlideType = (typeof SLIDE_TYPES)[number];

export const SLIDE_TYPE_LABEL: Record<SlideType, string> = {
  IMAGE_STILL: 'Image',
  IMAGE_KENBURNS: 'Image (Ken Burns)',
  VIDEO_CLIP: 'Video clip',
  TEXT_CARD: 'Text card',
  BEFORE_AFTER: 'Before / after',
  QUOTE: 'Quote',
  STATISTIC: 'Statistic',
  PRODUCT: 'Product',
};

export const TRANSITIONS = ['cut', 'fade', 'wipe', 'slide', 'zoom'] as const;
export type Transition = (typeof TRANSITIONS)[number];

export interface SlideContent {
  role?: 'hook' | 'body' | 'cta';
  text?: string;
  caption?: string;
  number?: number;
  quote?: string;
  author?: string;
  value?: string;
  label?: string;
  name?: string;
  features?: string[];
  price?: string;
  beforeImageId?: string;
  afterImageId?: string;
  pendingText?: boolean;
  imageQuery?: string;
}

export interface Slide {
  id: string;
  projectId: string;
  sortOrder: number;
  slideType: SlideType;
  imageAssetId: string | null;
  videoAssetId: string | null;
  backgroundColor: string | null;
  durationSec: number;
  transitionIn: string | null;
  transitionOut: string | null;
  content: SlideContent;
  /** Why the slide cannot render yet (null = renderable). */
  problem: string | null;
}

export interface SlideshowTemplate {
  id: string;
  organisationId: string | null;
  name: string;
  category: string;
  slidePlan: unknown;
  musicMood: string | null;
  defaultDurationPerSlide: number;
}

export function slideCount(template: SlideshowTemplate): number | null {
  return Array.isArray(template.slidePlan) ? template.slidePlan.length : null;
}

/** "photo_dump" → "Photo dump". */
export function categoryLabel(category: string): string {
  const text = category.replace(/_/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : category;
}
