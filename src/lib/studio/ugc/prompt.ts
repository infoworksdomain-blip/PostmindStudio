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
    others.length
      ? `Other shots (${others.join(', ')}) are short product B-roll or a closing card: they have NO voiceoverText (the creator’s voice is only in UGC_ACTOR shots); put any words for them in onScreenText.`
      : '',
    'sceneDescription for a UGC_ACTOR shot says what the creator does (e.g. holds the product up to the camera, points at it, smiles); never describe their face or name a real person.',
    product ? `The product is "${product}"; show it in the creator’s hand where it fits.` : '',
    'Never say "I am a real customer", invent ratings, prices or results, or mention being an AI.',
  ]
    .filter(Boolean)
    .join('\n');
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
}): string {
  const { style } = input;
  const product = clean(style.product.name, 120);
  const scene = clean(input.sceneDescription, 400);
  const camera = clean(input.cameraDirection, 120);
  return [
    'Vertical selfie-style smartphone video, handheld with slight natural camera shake, natural daylight, authentic user-generated content look.',
    `The person on camera is ${actorDescription(style)}, a fictional person, in ${SETTING_TEXT[style.actor.setting]}.`,
    'They look into the phone camera and talk naturally and warmly, like a creator recommending something to a friend; their lip movements match their words exactly.',
    scene && `Action: ${scene}.`,
    input.productReference
      ? `They hold the product from the reference image${product ? ` (${product})` : ''} clearly in view of the camera.`
      : product
        ? `${product} is in view where it fits.`
        : '',
    camera && `Camera: ${camera}.`,
    'Audio: only their voice and quiet room tone, no music. No subtitles, captions, on-screen text, logos or watermarks.',
  ]
    .filter(Boolean)
    .join(' ');
}
