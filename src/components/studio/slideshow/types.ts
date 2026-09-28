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

/** The server's slide problems (lib/studio/slideshow/planner.ts slideProblem) → message keys. */
export const SLIDE_PROBLEM_KEY = {
  'text not written yet (run auto-populate or edit the slide)': 'pendingText',
  'needs an image': 'needsImage',
  'needs a video clip': 'needsClip',
  'needs text': 'needsText',
  'needs before and after images': 'needsBeforeAfter',
  'needs a quote': 'needsQuote',
  'needs a value and label': 'needsValueLabel',
  'needs a product name': 'needsProductName',
} as const;
export type SlideProblemKey = (typeof SLIDE_PROBLEM_KEY)[keyof typeof SLIDE_PROBLEM_KEY];

export function slideProblemKey(problem: string): SlideProblemKey | null {
  return Object.prototype.hasOwnProperty.call(SLIDE_PROBLEM_KEY, problem)
    ? SLIDE_PROBLEM_KEY[problem as keyof typeof SLIDE_PROBLEM_KEY]
    : null;
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

/** "photo_dump" → "Photo dump" (template categories are organisation data, not catalogue keys). */
export function categoryLabel(category: string): string {
  const text = category.replace(/_/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : category;
}
