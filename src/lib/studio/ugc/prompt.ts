import type { VisualTreatment } from '@prisma/client';
import { actorDescription, SETTING_TEXT, type UgcStyle } from './style';

// BACKLOG 21.4 — the UGC-specific prompt text for Layers 1–3:
//   - ideation: the brief is a first-person creator review / testimonial (ugcIdeationSupplement);
//   - script: first person, conversational, hook in 2 s, problem → product → result → call to
//     action, 15–30 s, lines short enough for the clip lengths (ugcScriptSupplement);
//   - asset generation: the actor clip prompt (actorClipPrompt). The spoken line is NOT part of
//     it: each adapter puts the line in its own documented dialogue form (Veo: in quotes).
// Brief text and product names are owner data; they are fenced and quoted, never instructions.

/** About 2.5 spoken words a second (SCRIPT_SYSTEM_PROMPT); actors speak a little slower. */
export const ACTOR_WORDS_PER_SEC = 2.3;
/** Silence kept around a line inside its clip (start breath + end hold). */
export const ACTOR_LINE_PADDING_SEC = 0.8;

/** 21.4a: the actor portrait is selfie-shaped (1024×1536 from OpenAI; Kling's 9:16 first frame). */
export const PORTRAIT_ASPECT = '9:16' as const;

/** 21.4a: the line is spoken once, word for word; spare time is silent, not filled with words. */
export const ACTOR_LINE_ONCE =
  'They say their line exactly once, word for word, without repeating or adding any words; when the line is finished they stop talking and smile at the camera until the clip ends.';

function clean(text: string | null | undefined, max: number): string {
  return (text ?? '').replace(/\s+/g, ' ').replace(/"/g, "'").trim().slice(0, max);
}

/** Words a line of this many seconds can hold. */
export function maxWordsFor(clipSec: number): number {
  return Math.max(3, Math.floor((clipSec - ACTOR_LINE_PADDING_SEC) * ACTOR_WORDS_PER_SEC));
}

export function ugcIdeationSupplement(style: UgcStyle): string {
  const product = clean(style.product.name, 120);
  return [
    'Video style: UGC actor. A generated creator (not a real person, never a celebrity or anyone named) talks to camera on a phone, like a genuine customer review or creator recommendation.',
    product
      ? `The product to feature: "${product}".`
      : 'Feature the business’s main product or service.',
    'Write the hook as something the creator says in the first 2 seconds, in the first person.',
    'The creator must not claim to be a verified or real customer, give a star rating, or quote results the brief does not state.',
  ].join('\n');
}

/**
 * The Layer 2 supplement for a UGC script. `clipSeconds` are the only lengths an actor shot may
 * have (Veo renders 4, 6 or 8 s; 8 s only when the product image is used as a reference).
 */
export function ugcScriptSupplement(input: {
  style: UgcStyle;
  clipSeconds: readonly number[];
  actorClipBudget: number;
  treatments: readonly VisualTreatment[];
}): string {
  const { style, clipSeconds } = input;
  const product = clean(style.product.name, 120);
  const lengths = clipSeconds.map((s) => `${s} s (at most ${maxWordsFor(s)} words)`).join(', ');
  const others = input.treatments.filter((t) => t !== 'UGC_ACTOR');
  return [
    'UGC ACTOR VIDEO. One generated creator speaks to camera, first person, conversational, like a real phone video review.',
    'Structure: hook in the first 2 seconds, then the problem, the product, the result, and a call to action.',
    `UGC_ACTOR shots are the creator speaking their voiceoverText on camera. Use between 2 and ${input.actorClipBudget} UGC_ACTOR shots; each lasts exactly one of: ${lengths}. Keep every line short and natural, with contractions and no lists.`,
    'The first and last shots are UGC_ACTOR shots (hook and call to action).',
    // 21.4a: labels over a selfie cover the face; the actor's words are captioned anyway.
    'UGC_ACTOR shots have an empty onScreenText (their words are captioned, and a label would cover the face), except the first shot, which may have a hook label of at most 4 words.',
    // 21.4b: B-roll is product footage, the way Fastlane's UGC videos cut away (2026-10-05).
    others.length
      ? `${others.join(', ')} shots are product B-roll: the product being used, shown close-up like a phone-camera photo (sceneDescription describes hands holding or using the product, no person's face). Each lasts 2 to 3 seconds; put at most one B-roll shot between two UGC_ACTOR shots. They have NO voiceoverText (the creator’s voice is only in UGC_ACTOR shots); onScreenText is empty or one short line of at most 5 words. Never a title card, text card or graphic.`
      : '',
    'sceneDescription for a UGC_ACTOR shot says what the creator does (e.g. holds the product up to the camera, points at it, smiles); never describe their face or name a real person.',
    product ? `The product is "${product}"; show it in the creator’s hand where it fits.` : '',
    'Never say "I am a real customer", invent ratings, prices or results, or mention being an AI.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 21.4b: the image prompt for a UGC B-roll still that has to be generated (no product photo, no
 * library match): the product in use, close-up, like a phone photo, in the actor's setting.
 */
export function ugcStillPrompt(input: { style: UgcStyle; sceneDescription: string }): string {
  const product = clean(input.style.product.name, 120);
  const scene = clean(input.sceneDescription, 400);
  return [
    `Vertical phone-camera photo of hands using ${product ? `"${product}"` : 'the product'}, close-up, handheld, natural light, in ${SETTING_TEXT[input.style.actor.setting]}.`,
    scene && `Scene: ${scene}.`,
    'Authentic, unposed user-generated look, slight motion blur is fine; no face in frame.',
    'No text, captions, logos, watermarks or graphics.',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * The clip prompt for one UGC_ACTOR shot (without the spoken line). The actor description is the
 * same, word for word, in every clip of the project.
 */
export function actorClipPrompt(input: {
  style: UgcStyle;
  sceneDescription: string;
  cameraDirection?: string | null;
  /** True when the product image goes to the provider as a reference. */
  productReference: boolean;
  /** 21.4a: true when the project's actor portrait goes to the provider (ugc/portrait.ts). */
  actorReference?: boolean;
}): string {
  const { style } = input;
  const product = clean(style.product.name, 120);
  const scene = clean(input.sceneDescription, 400);
  const camera = clean(input.cameraDirection, 120);
  const person = input.actorReference
    ? `The person on camera is the same person as in the reference portrait (${actorDescription(style)}), a fictional person, with the same face, hair and clothes, in ${SETTING_TEXT[style.actor.setting]}.`
    : `The person on camera is ${actorDescription(style)}, a fictional person, in ${SETTING_TEXT[style.actor.setting]}.`;
  return [
    'Vertical selfie-style smartphone video, handheld with slight natural camera shake, natural daylight, authentic user-generated content look.',
    person,
    'They look into the phone camera and talk naturally and warmly, like a creator recommending something to a friend; their lip movements match their words exactly.',
    // 21.4a (production 2026-10-04: "calls, calls."): an 8 s clip holds a short line with time
    // to spare, and the actor filled it by repeating a word.
    ACTOR_LINE_ONCE,
    scene && `Action: ${scene}.`,
    input.productReference
      ? `They hold the product from the product reference image${product ? ` (${product})` : ''} clearly in view of the camera.`
      : product
        ? `${product} is in view where it fits.`
        : '',
    camera && `Camera: ${camera}.`,
    'Audio: only their voice and quiet room tone, no music. No subtitles, captions, on-screen text, logos or watermarks.',
  ]
    .filter(Boolean)
    .join(' ');
}
