import { describe, expect, it } from 'vitest';
import {
  ACTOR_LINE_ONCE,
  actorClipPrompt,
  maxWordsFor,
  ugcIdeationSupplement,
  ugcScriptSupplement,
  ugcStillPrompt,
} from './prompt';
import { actorDescription, newUgcStyle } from './style';

const style = newUgcStyle(
  {
    product: { name: 'Oat "barista" latte kit', imageId: 'img-1' },
    actor: { ageRange: '25-34', gender: 'woman', setting: 'kitchen' },
  },
  11,
);

describe('UGC prompts (21.4)', () => {
  it('lines fit their clip: about 2.3 words a second after padding', () => {
    expect(maxWordsFor(4)).toBe(7);
    expect(maxWordsFor(6)).toBe(11);
    expect(maxWordsFor(8)).toBe(16);
    expect(maxWordsFor(1)).toBe(3);
  });

  it('ideation: first person creator review, hook in 2 s, no fake testimonial, product quoted', () => {
    const text = ugcIdeationSupplement(style);
    expect(text).toContain('UGC actor');
    expect(text).toContain('not a real person, never a celebrity');
    expect(text).toContain('first 2 seconds');
    expect(text).toContain('must not claim to be a verified or real customer');
    expect(text).toContain(`"Oat 'barista' latte kit"`);
    expect(ugcIdeationSupplement(newUgcStyle({}, 1))).toContain('main product or service');
  });

  it('script: structure, clip lengths with word limits, budget, silent B-roll', () => {
    const text = ugcScriptSupplement({
      style,
      clipSeconds: [8],
      actorClipBudget: 3,
      treatments: ['UGC_ACTOR', 'IMAGE_STILL'],
    });
    expect(text).toContain('first person, conversational');
    expect(text).toContain(
      'hook in the first 2 seconds, then the problem, the product, the result',
    );
    expect(text).toContain('between 2 and 3 UGC_ACTOR shots');
    expect(text).toContain('8 s (at most 16 words)');
    // 21.4b: B-roll is the product in use, phone-camera style, 2–3 s, one between actor shots.
    expect(text).toContain('IMAGE_STILL shots are product B-roll: the product being used');
    expect(text).toContain('like a phone-camera photo');
    expect(text).toContain('Each lasts 2 to 3 seconds');
    expect(text).toContain('at most one B-roll shot between two UGC_ACTOR shots');
    expect(text).toContain('Never a title card, text card or graphic');
    expect(text).not.toContain('closing card');
    expect(text).toContain('NO voiceoverText');
    expect(text).toContain('Never say "I am a real customer"');
  });

  it('21.4b: a generated B-roll still is a phone photo of hands using the product, no text', () => {
    const prompt = ugcStillPrompt({ style, sceneDescription: 'pours the latte into a mug' });
    expect(prompt).toContain(`phone-camera photo of hands using "Oat 'barista' latte kit"`);
    expect(prompt).toContain('a bright, lived-in home kitchen');
    expect(prompt).toContain('Scene: pours the latte into a mug.');
    expect(prompt).toContain('No text, captions, logos');
    expect(ugcStillPrompt({ style: newUgcStyle({}, 3), sceneDescription: '' })).toContain(
      'hands using the product',
    );
  });

  it('actor clip prompt: selfie framing, the fixed actor, setting, product reference, no music or text', () => {
    const prompt = actorClipPrompt({
      style,
      sceneDescription: 'holds the jar up and smiles',
      cameraDirection: 'close selfie',
      productReference: true,
    });
    expect(prompt).toContain('Vertical selfie-style smartphone video, handheld');
    expect(prompt).toContain(
      `The person on camera is ${actorDescription(style)}, a fictional person`,
    );
    expect(prompt).toContain('a bright, lived-in home kitchen');
    expect(prompt).toContain('lip movements match their words');
    expect(prompt).toContain("product from the product reference image (Oat 'barista' latte kit)");
    expect(prompt).toContain(ACTOR_LINE_ONCE);
    expect(prompt).toContain('Action: holds the jar up and smiles.');
    expect(prompt).toContain('Camera: close selfie.');
    expect(prompt).toContain('no music');
    expect(prompt).toContain('No subtitles');
    // The spoken line is the adapter's job (each provider has its own dialogue form).
    expect(prompt).not.toContain('says:');
  });

  it('21.4a: with the actor portrait the clip points at it and keeps the same description', () => {
    const prompt = actorClipPrompt({
      style,
      sceneDescription: 'waves',
      productReference: false,
      actorReference: true,
    });
    expect(prompt).toContain(
      `the same person as in the reference portrait (${actorDescription(style)}), a fictional person, with the same face, hair and clothes`,
    );
    expect(prompt).toContain('exactly once, word for word, without repeating');
  });

  it('21.4a: script supplement keeps labels off actor shots except a short hook', () => {
    const text = ugcScriptSupplement({
      style,
      clipSeconds: [8],
      actorClipBudget: 3,
      treatments: ['UGC_ACTOR', 'IMAGE_STILL'],
    });
    expect(text).toContain('UGC_ACTOR shots have an empty onScreenText');
    expect(text).toContain('hook label of at most 4 words');
  });

  it('without a product image the product is named in view; without a product nothing is said', () => {
    expect(
      actorClipPrompt({ style, sceneDescription: 'waves', productReference: false }),
    ).toContain("Oat 'barista' latte kit is in view");
    const plain = actorClipPrompt({
      style: newUgcStyle({}, 2),
      sceneDescription: 'waves',
      productReference: false,
    });
    expect(plain).not.toContain('in view where it fits');
  });
});
