import type { VisualTreatment } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import type { PlannedScript, PlannedShot } from '../pipeline/scripting';
import {
  actorClipBudget,
  actorClipLength,
  actorClipSeconds,
  applyUgcPlan,
  fitUgcDurations,
  ugcTreatments,
  ugcUsesReferenceImage,
} from './plan';

function shot(
  visualTreatment: VisualTreatment,
  durationSec: number,
  voiceoverText: string | null,
  onScreenText: string | null = null,
): PlannedShot {
  return {
    sortOrder: 0,
    durationSec,
    visualTreatment,
    sceneDescription: 'scene',
    cameraDirection: null,
    voiceoverText,
    onScreenText,
    transitionOut: 'cut',
  };
}

const sum = (plan: PlannedScript) =>
  Math.round(plan.shots.reduce((t, s) => t + s.durationSec, 0) * 10) / 10;

describe('reference images force 8 s actor clips (21.4a)', () => {
  const reg = (has: boolean) => ({
    getAdaptersByCapability: () => (has ? [{}] : []) as never[],
  });
  it('a product photo or an image generator (the actor portrait) means references', () => {
    expect(ugcUsesReferenceImage('img-1', reg(false))).toBe(true);
    expect(ugcUsesReferenceImage(null, reg(true))).toBe(true);
    expect(ugcUsesReferenceImage(null, reg(false))).toBe(false);
    expect(actorClipSeconds(true)).toEqual([8]);
    expect(actorClipSeconds(false)).toEqual([4, 6, 8]);
  });
});

describe('actor clip budget (21.4)', () => {
  it.each([
    ['BASIC', 30, 3],
    ['STANDARD', 15, 2],
    ['STANDARD', 30, 3],
    ['STANDARD', 60, 6],
    ['PLUS', 30, 4],
    ['ENTERPRISE', 30, 4],
    ['PLUS', 60, 8],
  ] as const)('%s, %ss: %d actor clips', (tier, sec, n) => {
    expect(actorClipBudget(tier, sec)).toBe(n);
  });

  it('clip lengths are Veo’s, 8 s only with a product reference', () => {
    expect(actorClipSeconds(false)).toEqual([4, 6, 8]);
    expect(actorClipSeconds(true)).toEqual([8]);
  });

  it('picks the shortest clip that holds the line', () => {
    expect(actorClipLength(shot('UGC_ACTOR', 3, 'Okay, this is good.'), [4, 6, 8])).toBe(4);
    expect(
      actorClipLength(
        shot(
          'UGC_ACTOR',
          4,
          'So I tried this for a week and honestly my skin feels so much better',
        ),
        [4, 6, 8],
      ),
    ).toBe(8);
    expect(actorClipLength(shot('UGC_ACTOR', 5, 'Short.'), [4, 6, 8])).toBe(6);
    expect(actorClipLength(shot('UGC_ACTOR', 3, 'Short.'), [8])).toBe(8);
  });
});

describe('ugcTreatments', () => {
  const registry = (actors: number) => ({
    getAdaptersByCapability: () => Array.from({ length: actors }, () => ({}) as never),
  });
  it('21.4b: actors when a provider can make them, then product stills only (never a card)', () => {
    expect(ugcTreatments(registry(1))).toEqual(['UGC_ACTOR', 'IMAGE_STILL']);
    expect(ugcTreatments(registry(0))).toEqual(['IMAGE_STILL']);
    for (const t of ugcTreatments(registry(1))) {
      expect(t).not.toBe('TEXT_CARD');
      expect(t).not.toBe('MOTION_GRAPHICS');
    }
  });
});

describe('UGC B-roll is product footage, never a poster (21.4b)', () => {
  const plan: PlannedScript = {
    fullText: 'x',
    shots: [
      shot('UGC_ACTOR', 8, 'Okay, client calls used to wreck me.'),
      shot('MOTION_GRAPHICS', 3, null, 'Preps your opener'),
      shot('UGC_ACTOR', 8, 'Now I just open the app first.'),
      shot('TEXT_CARD', 4, null, 'Closes with confidence'),
      shot('UGC_ACTOR', 8, 'Try it, link below.'),
    ],
    beats: ['hook', 'demo', 'demo', 'other', 'cta'],
  };

  it('never yields TEXT_CARD or MOTION_GRAPHICS; B-roll is 2–3 s with one short line', () => {
    const { plan: out } = applyUgcPlan(plan, { budget: 3, targetSec: 30, clipSeconds: [8] });
    expect(out.shots.map((s) => s.visualTreatment)).toEqual([
      'UGC_ACTOR',
      'IMAGE_STILL',
      'UGC_ACTOR',
      'IMAGE_STILL',
      'UGC_ACTOR',
    ]);
    for (const s of out.shots.filter((x) => x.visualTreatment !== 'UGC_ACTOR')) {
      expect(s.durationSec).toBeGreaterThanOrEqual(2);
      expect(s.durationSec).toBeLessThanOrEqual(3);
      expect(s.voiceoverText).toBeNull();
    }
    expect(out.shots[1]?.onScreenText).toBe('Preps your opener');
    expect(sum(out)).toBe(30);
  });

  it('an actor shot over the budget becomes a 2–3 s product still with its line shortened', () => {
    const long: PlannedScript = {
      ...plan,
      shots: [
        ...plan.shots.slice(0, 4),
        shot('UGC_ACTOR', 8, 'And honestly the best part is it remembers every client I have'),
        plan.shots[4] as PlannedShot,
      ],
      beats: ['hook', 'demo', 'demo', 'other', 'other', 'cta'],
    };
    const { plan: out, converted } = applyUgcPlan(long, {
      budget: 3,
      targetSec: 32,
      clipSeconds: [8],
    });
    expect(converted).toBe(1);
    const still = out.shots[4];
    expect(still?.visualTreatment).toBe('IMAGE_STILL');
    expect(still?.durationSec).toBeGreaterThanOrEqual(2);
    expect(still?.durationSec).toBeLessThanOrEqual(3);
    expect((still?.onScreenText ?? '').length).toBeLessThanOrEqual(40);
    expect(out.shots.some((s) => s.visualTreatment === 'TEXT_CARD')).toBe(false);
  });

  it('widens B-roll only when 2–3 s cannot fill the video next to short actor clips', () => {
    const shots = fitUgcDurations(
      [
        { ...shot('UGC_ACTOR', 4, 'Hi.'), durationSec: 4 },
        shot('IMAGE_STILL', 3, null, 'x'),
        { ...shot('UGC_ACTOR', 4, 'Bye.'), durationSec: 4 },
      ],
      15,
    );
    expect(shots.map((s) => s.durationSec)).toEqual([4, 7, 4]);
    const tight = fitUgcDurations(
      [
        shot('UGC_ACTOR', 8, 'Hi.'),
        shot('IMAGE_STILL', 6, null, 'x'),
        shot('UGC_ACTOR', 8, 'Bye.'),
      ],
      19,
    );
    expect(tight.map((s) => s.durationSec)).toEqual([8, 3, 8]);
  });
});

describe('applyUgcPlan', () => {
  const plan: PlannedScript = {
    fullText: 'x',
    shots: [
      shot('UGC_ACTOR', 3, 'Stop scrolling if mornings are chaos.'),
      shot('IMAGE_STILL', 4, 'This is the kit.', null),
      shot('UGC_ACTOR', 6, 'I make a proper latte in two minutes now.'),
      shot('UGC_ACTOR', 6, 'And it tastes better than the café.'),
      shot('TEXT_CARD', 3, null, 'Shop now'),
      shot('UGC_ACTOR', 5, 'Link is in the bio, go try it.'),
    ],
    beats: ['hook', 'demo', 'demo', 'other', 'other', 'cta'],
  };

  it('keeps hook and CTA actors within the budget, converts the rest, silences B-roll', () => {
    const {
      plan: out,
      actorShots,
      converted,
    } = applyUgcPlan(plan, {
      budget: 3,
      targetSec: 30,
      clipSeconds: [4, 6, 8],
    });
    expect(actorShots).toBe(3);
    expect(converted).toBe(1);
    const treatments = out.shots.map((s) => s.visualTreatment);
    expect(treatments[0]).toBe('UGC_ACTOR'); // hook
    expect(treatments[5]).toBe('UGC_ACTOR'); // call to action
    expect(treatments[3]).toBe('IMAGE_STILL'); // the "other" actor shot over budget
    expect(treatments[4]).toBe('IMAGE_STILL'); // 21.4b: the card became product B-roll
    expect(out.shots[3]?.providerRouting).toMatchObject({
      clipBudget: { convertedFrom: 'UGC_ACTOR', budget: 3 },
    });
    // Only actors speak; B-roll lines move on screen.
    for (const s of out.shots) {
      if (s.visualTreatment === 'UGC_ACTOR') expect(s.voiceoverText).toBeTruthy();
      else expect(s.voiceoverText).toBeNull();
    }
    expect(out.shots[1]?.onScreenText).toBe('This is the kit.');
    expect(out.shots[3]?.onScreenText).toBe('And it tastes better than the café.');
    expect(out.shots[4]?.onScreenText).toBe('Shop now');
    // Actor shots are exact clip lengths; the others absorb the rest of the 30 s.
    for (const s of out.shots.filter((x) => x.visualTreatment === 'UGC_ACTOR'))
      expect([4, 6, 8]).toContain(s.durationSec);
    expect(sum(out)).toBe(30);
  });

  it('with a product reference every actor clip is 8 s', () => {
    const { plan: out } = applyUgcPlan(plan, { budget: 3, targetSec: 30, clipSeconds: [8] });
    expect(
      out.shots.filter((s) => s.visualTreatment === 'UGC_ACTOR').map((s) => s.durationSec),
    ).toEqual([8, 8, 8]);
    expect(sum(out)).toBe(30);
  });

  it('an actor shot without a line becomes a product still', () => {
    const { plan: out, converted } = applyUgcPlan(
      { fullText: '', shots: [shot('UGC_ACTOR', 4, null), shot('UGC_ACTOR', 6, 'Hi there.')] },
      { budget: 3, targetSec: 10, clipSeconds: [4, 6, 8] },
    );
    expect(converted).toBe(1);
    expect(out.shots[0]?.visualTreatment).toBe('IMAGE_STILL');
  });
});
