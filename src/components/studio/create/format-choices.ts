// The Create screen's per-format choices (21.4 UGC, 21.6 carousels, 22.1 hook + demo, 22.2 wall of
// text): their shapes, defaults and limits (mirroring the server's), and the UGC body. body.ts
// re-exports everything here.

export type CarouselTheme = 'light' | 'dark';

/** 22.1: the Create screen's hook + demo choices (formats/hook-demo.ts). */
export interface HookDemoChoice {
  demoUploadId: string | null;
  hookLine: string;
  hookSource: 'ai_creator' | 'library';
  reaction: 'surprised' | 'curious' | 'wait_what';
  layout: 'sequential' | 'stacked';
  audioMix: 'demo' | 'balanced' | 'music';
}

export const EMPTY_HOOK_DEMO: HookDemoChoice = {
  demoUploadId: null,
  hookLine: '',
  hookSource: 'ai_creator',
  reaction: 'surprised',
  layout: 'sequential',
  audioMix: 'balanced',
};

/** 22.2: the Create screen's wall-of-text choices (formats/wall-of-text.ts). */
export interface WallOfTextChoice {
  text: string;
  background: 'calm' | 'nature' | 'city' | 'abstract';
  durationSec: number;
}

export const EMPTY_WALL_OF_TEXT: WallOfTextChoice = {
  text: '',
  background: 'calm',
  durationSec: 8,
};
/** formats/hook-demo.ts HOOK_LINE_MAX_WORDS / HOOK_LINE_MAX_CHARS (22.6: 9 words, 80 chars). */
export const HOOK_LINE_MAX_WORDS = 9;
export const HOOK_LINE_MAX_CHARS = 80;
export const WALL_TEXT_MAX_WORDS = 60;
export const WALL_TEXT_MAX_LINES = 10;
/** formats/copy-prompt.ts WALL_TEXT_MAX_CHARS (the overlay API's text limit). */
export const WALL_TEXT_MAX_CHARS = 500;
export const WALL_SECONDS = [6, 8, 10, 12] as const;

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** 21.6: the carousel options on Create (carousel/constants.ts MIN_POSTS..MAX_POSTS). */
export const CAROUSEL_POSTS_MIN = 3;
export const CAROUSEL_POSTS_MAX = 12;
export const CAROUSEL_POSTS_DEFAULT = 7;
export const CAROUSEL_THREAD_MAX = 7_200;

/** 21.4: the Create screen's UGC actor choices ('' = Studio picks; ugc/style.ts presets). */
export interface UgcChoice {
  productName: string;
  productImageId: string | null;
  ageRange: '' | '18-24' | '25-34' | '35-44' | '45-60';
  gender: '' | 'woman' | 'man';
  setting: '' | 'kitchen' | 'living_room' | 'car' | 'outdoors' | 'bathroom' | 'desk' | 'shop';
  /**
   * 22.3: a reusable creator of the business (its face in every clip), null for a new one-off
   * actor, undefined until the picker has chosen its default (the business's most used creator).
   */
  creatorId?: string | null;
}

export const EMPTY_UGC: UgcChoice = {
  productName: '',
  productImageId: null,
  ageRange: '',
  gender: '',
  setting: '',
};

/** The POST /projects ugc body (services/projects.ts, ugc/style.ts ugcInput). */
export interface UgcBody {
  product?: { name?: string; imageId?: string };
  actor?: { ageRange?: string; gender?: string; setting?: string };
  creatorId?: string;
}

/**
 * 21.4: only the choices the owner made (the server picks the rest from the project's seed).
 * 22.3: a chosen creator replaces the actor look (its own presets and portrait are used).
 */
export function ugcBody(choice: UgcChoice): UgcBody {
  const name = choice.productName.trim().slice(0, 120);
  const product = {
    ...(name && { name }),
    ...(choice.productImageId && { imageId: choice.productImageId }),
  };
  if (choice.creatorId)
    return {
      ...(Object.keys(product).length > 0 && { product }),
      creatorId: choice.creatorId,
    };
  const actor = {
    ...(choice.ageRange && { ageRange: choice.ageRange }),
    ...(choice.gender && { gender: choice.gender }),
    ...(choice.setting && { setting: choice.setting }),
  };
  return {
    ...(Object.keys(product).length > 0 && { product }),
    ...(Object.keys(actor).length > 0 && { actor }),
  };
}
