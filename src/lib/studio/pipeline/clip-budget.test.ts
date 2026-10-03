import type { VisualTreatment } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  AI_CLIP_MAX_SEC,
  aiClipBudget,
  aiClipResolution,
  applyClipBudget,
  beatOf,
  capAiClipDurations,
  clipBudgetOf,
  keptAiShots,
} from './clip-budget';
import {
  buildScriptPrompt,
  clipBudgetLine,
  normaliseScript,
  scriptSchema,
  type PlannedScript,
  type PlannedShot,
  type ShotBeat,
} from './scripting';

function shot(visualTreatment: VisualTreatment, durationSec: number, sortOrder = 0): PlannedShot {
  return {
    sortOrder,
    durationSec,
    visualTreatment,
    sceneDescription: `scene ${sortOrder}`,
    cameraDirection: null,
    voiceoverText: visualTreatment === 'AI_AVATAR' ? 'Hello there' : `line ${sortOrder}`,
    onScreenText: null,
    transitionOut: 'cut',
    sfxCue: null,
  };
}

function script(
  treatments: VisualTreatment[],
  sec = 3,
  beats?: Array<ShotBeat | null>,
): PlannedScript {
  return {
    fullText: 'text',
    shots: treatments.map((t, i) => shot(t, sec, i)),
    ...(beats && { beats }),
  };
}

const total = (plan: PlannedScript) =>
  Math.round(plan.shots.reduce((sum, s) => sum + s.durationSec, 0) * 10) / 10;
const aiIndexes = (plan: PlannedScript) =>
  plan.shots.flatMap((s, i) =>
    s.visualTreatment === 'AI_CLIP' || s.visualTreatment === 'AI_AVATAR' ? [i] : [],
  );

describe('aiClipBudget (20.25 per-tier budgets)', () => {
  it('a 30 s short: BASIC 3, STANDARD 4, PLUS 6, ENTERPRISE 6', () => {
    expect(aiClipBudget('BASIC', 30)).toBe(3);
    expect(aiClipBudget('STANDARD', 30)).toBe(4);
    expect(aiClipBudget('PLUS', 30)).toBe(6);
    expect(aiClipBudget('ENTERPRISE', 30)).toBe(6);
  });

  it('scales with length, never under two', () => {
    expect(aiClipBudget('BASIC', 15)).toBe(2);
    expect(aiClipBudget('BASIC', 6)).toBe(2);
    expect(aiClipBudget('STANDARD', 15)).toBe(2);
    expect(aiClipBudget('PLUS', 15)).toBe(3);
    expect(aiClipBudget('BASIC', 60)).toBe(6);
    expect(aiClipBudget('STANDARD', 60)).toBe(9);
    expect(aiClipBudget('PLUS', 60)).toBe(12);
    expect(aiClipBudget('STANDARD', 0)).toBe(2);
    expect(aiClipBudget('STANDARD', Number.NaN)).toBe(2);
  });

  it('long form: one clip per 8 s after the first minute', () => {
    expect(aiClipBudget('STANDARD', 180)).toBe(24); // 60/7 + 120/8 = 23.6
    expect(aiClipBudget('PLUS', 360)).toBe(50); // 60/5 + 300/8 = 49.5
    expect(aiClipBudget('BASIC', 120)).toBe(12); // BASIC's own rate (10 s) is already slower than 8 s
  });

  it('resolution per tier: 480p on BASIC, 720p otherwise', () => {
    expect(aiClipResolution('BASIC')).toBe('480p');
    expect(aiClipResolution('STANDARD')).toBe('720p');
    expect(aiClipResolution('PLUS')).toBe('720p');
    expect(aiClipResolution('ENTERPRISE')).toBe('720p');
  });
});

describe('beatOf / keptAiShots (priorities)', () => {
  it('position decides when the model gave no beat: first = hook, last = cta', () => {
    expect(beatOf(0, 5)).toBe('hook');
    expect(beatOf(4, 5)).toBe('cta');
    expect(beatOf(2, 5)).toBe('other');
    expect(beatOf(0, 1)).toBe('hook');
    expect(beatOf(2, 5, 'demo')).toBe('demo');
    expect(beatOf(0, 5, 'other')).toBe('hook');
  });

  it('keeps hook, then CTA, then the demo, then spreads the rest', () => {
    const shots = script(Array<VisualTreatment>(8).fill('AI_CLIP')).shots;
    const beats: Array<ShotBeat | null> = [null, null, null, null, null, 'demo', null, null];
    expect([...keptAiShots(shots, beats, 1)]).toEqual([0]);
    expect([...keptAiShots(shots, beats, 2)].sort()).toEqual([0, 7]);
    expect([...keptAiShots(shots, beats, 3)].sort()).toEqual([0, 5, 7]);
    // The 4th is the "other" shot farthest from 0, 5 and 7: index 2 or 3 (2 is first).
    expect([...keptAiShots(shots, beats, 4)].sort()).toEqual([0, 2, 5, 7]);
  });

  it('a budget of zero keeps nothing; a budget above the AI shots keeps them all', () => {
    const shots = script(['AI_CLIP', 'TEXT_CARD', 'AI_CLIP']).shots;
    expect(keptAiShots(shots, undefined, 0).size).toBe(0);
    expect([...keptAiShots(shots, undefined, 5)].sort()).toEqual([0, 2]);
  });
});

describe('applyClipBudget (storyboard enforcement)', () => {
  it('too many AI shots → the extras become budget stills; hook, demo and CTA kept', () => {
    const plan = script(
      [
        'AI_CLIP',
        'AI_CLIP',
        'AI_CLIP',
        'AI_CLIP',
        'AI_CLIP',
        'AI_CLIP',
        'AI_CLIP',
        'AI_CLIP',
        'AI_CLIP',
        'AI_CLIP',
      ],
      3,
      ['hook', 'other', 'other', 'other', 'demo', 'other', 'other', 'other', 'other', 'cta'],
    );
    const { plan: out, converted, aiShots } = applyClipBudget(plan, { budget: 4, targetSec: 30 });
    expect(converted).toBe(6);
    expect(aiShots).toBe(4);
    expect(aiIndexes(out)).toEqual(expect.arrayContaining([0, 4, 9]));
    expect(aiIndexes(out)).toHaveLength(4);
    for (const [i, s] of out.shots.entries()) {
      if (aiIndexes(out).includes(i)) {
        expect(clipBudgetOf(s.providerRouting)).toBeNull();
        continue;
      }
      expect(s.visualTreatment).toBe('IMAGE_STILL');
      expect(clipBudgetOf(s.providerRouting)).toEqual({ convertedFrom: 'AI_CLIP', budget: 4 });
    }
    expect(total(out)).toBe(30);
    // the input plan is not mutated
    expect(plan.shots.every((s) => s.visualTreatment === 'AI_CLIP')).toBe(true);
  });

  it('avatar shots count towards the budget and convert the same way', () => {
    const plan = script(['AI_AVATAR', 'AI_CLIP', 'AI_AVATAR', 'TEXT_CARD', 'AI_CLIP']);
    const { plan: out, converted } = applyClipBudget(plan, { budget: 2, targetSec: 15 });
    expect(converted).toBe(2);
    expect(out.shots.map((s) => s.visualTreatment)).toEqual([
      'AI_AVATAR',
      'IMAGE_STILL',
      'IMAGE_STILL',
      'TEXT_CARD',
      'AI_CLIP',
    ]);
    expect(clipBudgetOf(out.shots[2]?.providerRouting)).toEqual({
      convertedFrom: 'AI_AVATAR',
      budget: 2,
    });
    // the narration stays with the converted shot
    expect(out.shots[2]?.voiceoverText).toBe('Hello there');
  });

  it('within budget: nothing converted, cheaper shots untouched', () => {
    const plan = script(['AI_CLIP', 'IMAGE_STILL', 'MOTION_GRAPHICS', 'AI_CLIP']);
    const { plan: out, converted } = applyClipBudget(plan, { budget: 3, targetSec: 12 });
    expect(converted).toBe(0);
    expect(out.shots.map((s) => s.visualTreatment)).toEqual([
      'AI_CLIP',
      'IMAGE_STILL',
      'MOTION_GRAPHICS',
      'AI_CLIP',
    ]);
    expect(out.shots.every((s) => s.providerRouting === undefined)).toBe(true);
  });

  it('keeps an existing routing snapshot when it converts a shot', () => {
    const plan = script(['AI_CLIP', 'AI_CLIP', 'AI_CLIP']);
    const pre = { ...plan.shots[1]!, providerRouting: { preferredProviderId: 'kling' } };
    const { plan: out } = applyClipBudget(
      { ...plan, shots: [plan.shots[0]!, pre, plan.shots[2]!] },
      { budget: 2, targetSec: 9 },
    );
    expect(out.shots[1]?.providerRouting).toEqual({
      preferredProviderId: 'kling',
      clipBudget: { convertedFrom: 'AI_CLIP', budget: 2 },
    });
  });

  it('AI clips are kept to 4 s; the other shots take up the time', () => {
    const plan = script(['AI_CLIP', 'IMAGE_STILL', 'IMAGE_STILL', 'IMAGE_STILL', 'AI_CLIP'], 6);
    const { plan: out } = applyClipBudget(plan, { budget: 2, targetSec: 30 });
    expect(out.shots[0]?.durationSec).toBe(AI_CLIP_MAX_SEC);
    expect(out.shots[4]?.durationSec).toBe(AI_CLIP_MAX_SEC);
    expect(total(out)).toBe(30);
    for (const s of out.shots.slice(1, 4)) expect(s.durationSec).toBeGreaterThan(6);
  });

  it('when the other shots cannot absorb the time, the ordinary bounds are kept', () => {
    // two 10 s-max stills cannot take 22 s: the clips stay 7.5 s rather than miss the length
    const plan = script(['AI_CLIP', 'IMAGE_STILL', 'IMAGE_STILL', 'AI_CLIP'], 7.5);
    const { plan: out } = applyClipBudget(plan, { budget: 2, targetSec: 30 });
    expect(total(out)).toBe(30);
    expect(out.shots[0]?.durationSec).toBe(7.5);
  });

  it('avatar shots keep their length: the freed time goes to the cheaper shots only', () => {
    const plan = script(['AI_AVATAR', 'AI_CLIP', 'TEXT_CARD'], 6);
    const shots = [plan.shots[0]!, plan.shots[1]!, { ...plan.shots[2]!, durationSec: 3 }];
    const out = capAiClipDurations(shots, 15);
    expect(out.map((s) => s.durationSec)).toEqual([6, 4, 5]);
  });

  it('a TEMPLATE keeps its shot lengths (keepDurations)', () => {
    const plan = script(['AI_CLIP', 'IMAGE_STILL', 'AI_CLIP'], 8);
    const { plan: out } = applyClipBudget(plan, { budget: 2, targetSec: 24, keepDurations: true });
    expect(out.shots.map((s) => s.durationSec)).toEqual([8, 8, 8]);
  });

  it('an all-AI script that cannot fill its length at 4 s keeps the ordinary bounds', () => {
    const plan = script(['AI_CLIP', 'AI_CLIP'], 7.5);
    const out = capAiClipDurations(plan.shots, 15);
    expect(out.map((s) => s.durationSec)).toEqual([7.5, 7.5]);
  });

  it('shots already within 4 s are left alone', () => {
    const plan = script(['AI_CLIP', 'TEXT_CARD'], 3);
    expect(capAiClipDurations(plan.shots, 6)).toBe(plan.shots);
  });
});

describe('clipBudgetOf', () => {
  it('reads only a well-formed marker', () => {
    expect(clipBudgetOf({ clipBudget: { convertedFrom: 'AI_CLIP', budget: 3 } })).toEqual({
      convertedFrom: 'AI_CLIP',
      budget: 3,
    });
    expect(clipBudgetOf(null)).toBeNull();
    expect(clipBudgetOf([])).toBeNull();
    expect(clipBudgetOf({ clipBudget: 'yes' })).toBeNull();
    expect(clipBudgetOf({ clipBudget: { convertedFrom: 'AI_CLIP' } })).toBeNull();
    expect(clipBudgetOf({ visual: { providerId: 'x' } })).toBeNull();
  });
});

describe('script prompt and schema (the model is told the budget)', () => {
  const treatments: VisualTreatment[] = ['AI_CLIP', 'IMAGE_STILL', 'TEXT_CARD', 'MOTION_GRAPHICS'];
  const brief = {
    actionable: true,
    directionOptions: [],
    hook: 'h',
    keyMessage: 'k',
    targetAudience: 'a',
    tone: 't',
    callToAction: 'c',
    keywords: [],
    restrictedTopicsMentioned: [],
  };

  it('states the budget, the beats and the cheaper treatments available', () => {
    const line = clipBudgetLine(4, treatments);
    expect(line).toContain('at most 4 shot(s) may use AI_CLIP');
    expect(line).toContain('hook');
    expect(line).toContain('call to action');
    expect(line).toContain('2–4 seconds');
    expect(line).toContain('IMAGE_STILL (a photo with a slow pan or zoom');
    expect(line).toContain('TEXT_CARD or MOTION_GRAPHICS');
    expect(clipBudgetLine(4, ['IMAGE_STILL', 'TEXT_CARD'])).toBe('');
    const prompt = buildScriptPrompt({
      brief,
      format: { platform: 'tiktok', aspectRatio: '9:16', durationSec: 30 },
      treatments,
      restrictedTopics: [],
      aiClipBudget: 4,
    });
    expect(prompt).toContain('AI clip budget: at most 4');
    expect(
      buildScriptPrompt({
        brief,
        format: { platform: 'tiktok', aspectRatio: '9:16', durationSec: 30 },
        treatments,
        restrictedTopics: [],
      }),
    ).not.toContain('AI clip budget');
  });

  it('the schema offers an optional beat and normaliseScript returns it per shot', () => {
    const schema = scriptSchema(treatments);
    const props = schema.properties.shots.items.properties;
    expect(props.beat.enum).toEqual(['hook', 'demo', 'cta', 'other']);
    expect(schema.properties.shots.items.required).not.toContain('beat');
    const base = {
      durationSec: 5,
      visualTreatment: 'AI_CLIP',
      sceneDescription: 's',
      cameraDirection: '',
      voiceoverText: 'v',
      onScreenText: '',
      transitionOut: 'cut',
    };
    const out = normaliseScript(
      { fullText: 'f', shots: [{ ...base, beat: 'hook' }, base, { ...base, beat: 'cta' }] },
      treatments,
      15,
    );
    expect(out.beats).toEqual(['hook', null, 'cta']);
    expect(() =>
      normaliseScript({ fullText: 'f', shots: [{ ...base, beat: 'climax' }] }, treatments, 5),
    ).toThrow();
  });
});
