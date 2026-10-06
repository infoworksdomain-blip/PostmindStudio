import { describe, expect, it } from 'vitest';
import {
  AUDIO_MIX_LEVELS,
  effectiveLayout,
  HOOK_DEMO_ALLOWANCE_UNITS,
  hookDemoCreateInput,
  hookDemoTiming,
  newHookDemoDocument,
  readHookDemo,
} from './hook-demo';
import { allowanceUnitsOf } from '../ugc/allowance';
import { WALL_OF_TEXT_ALLOWANCE_UNITS, newWallOfTextDocument } from './wall-of-text';

// BACKLOG 22.1 — hook + demo input, stored document, timing and audio mix.

describe('hookDemoCreateInput', () => {
  it('fills the defaults (AI creator, surprised, sequential, balanced, 15 s)', () => {
    expect(hookDemoCreateInput.parse({})).toEqual({
      hookSource: 'ai_creator',
      reaction: 'surprised',
      layout: 'sequential',
      audioMix: 'balanced',
      targetSec: 15,
    });
  });

  it('accepts a hook line of up to 12 words', () => {
    const hookLine = 'one two three four five six seven eight nine ten eleven twelve';
    expect(hookDemoCreateInput.parse({ hookLine }).hookLine).toBe(hookLine);
  });

  it.each([
    ['13 words', 'one two three four five six seven eight nine ten eleven twelve thirteen'],
    ['two lines', 'first line\nsecond line'],
    ['an emoji', 'This app is fire 🔥'],
    ['nothing', '   '],
  ])('refuses a hook line with %s', (_label, hookLine) => {
    expect(hookDemoCreateInput.safeParse({ hookLine }).success).toBe(false);
  });

  it('keeps the target inside 10–20 s and refuses unknown keys', () => {
    expect(hookDemoCreateInput.safeParse({ targetSec: 9 }).success).toBe(false);
    expect(hookDemoCreateInput.safeParse({ targetSec: 21 }).success).toBe(false);
    expect(hookDemoCreateInput.safeParse({ hookSec: 2 }).success).toBe(false);
  });
});

describe('the stored document', () => {
  it('round-trips through metadata.hookDemo', () => {
    const doc = newHookDemoDocument(hookDemoCreateInput.parse({ hookLine: 'Wait for it' }), {
      uploadId: 'up-1',
      assetId: 'as-1',
    });
    expect(readHookDemo({ hookDemo: doc })).toEqual(doc);
    expect(readHookDemo({ hookDemo: { ...doc, layout: 'diagonal' } })).toBeNull();
    expect(readHookDemo(null)).toBeNull();
  });
});

describe('hookDemoTiming', () => {
  it('3 s hook, then the demo fills the 15 s target', () => {
    expect(hookDemoTiming({ targetSec: 15, demoDurationSec: 60 })).toEqual({
      hookSec: 3,
      demoSec: 12,
      totalSec: 15,
    });
  });

  it('a short demo plays whole and the total is a whole number of seconds', () => {
    expect(hookDemoTiming({ targetSec: 20, demoDurationSec: 6.6 })).toEqual({
      hookSec: 3,
      demoSec: 6,
      totalSec: 9,
    });
  });

  it('clamps the hook to 1.5–4 s and the target to 10–20 s', () => {
    expect(hookDemoTiming({ targetSec: 30, demoDurationSec: 60, hookSec: 9 })).toMatchObject({
      hookSec: 4,
      totalSec: 20,
    });
    expect(hookDemoTiming({ targetSec: 5, demoDurationSec: 60, hookSec: 0.5 })).toMatchObject({
      hookSec: 1.5,
      demoSec: 8.5,
      totalSec: 10,
    });
  });
});

describe('audio mix and layout', () => {
  it('the music sits under the demo, and the "music" mix mutes the demo', () => {
    expect(AUDIO_MIX_LEVELS.demo.demo).toBeGreaterThan(AUDIO_MIX_LEVELS.demo.musicUnder);
    expect(AUDIO_MIX_LEVELS.music.demo).toBe(0);
  });

  it('stacked only for portrait outputs', () => {
    expect(effectiveLayout('stacked', '9:16')).toBe('stacked');
    expect(effectiveLayout('stacked', '4:5')).toBe('stacked');
    expect(effectiveLayout('stacked', '16:9')).toBe('sequential');
    expect(effectiveLayout('stacked', '1:1')).toBe('sequential');
    expect(effectiveLayout('sequential', '9:16')).toBe('sequential');
  });
});

describe('allowance units (22.1 / 22.2)', () => {
  it('a hook + demo video and a wall of text each use one video', () => {
    const doc = newHookDemoDocument(hookDemoCreateInput.parse({}), {
      uploadId: 'u',
      assetId: 'a',
    });
    expect(allowanceUnitsOf({ hookDemo: doc })).toBe(HOOK_DEMO_ALLOWANCE_UNITS);
    expect(
      allowanceUnitsOf({
        wallOfText: newWallOfTextDocument({ background: 'calm', durationSec: 8 }),
      }),
    ).toBe(WALL_OF_TEXT_ALLOWANCE_UNITS);
    expect(HOOK_DEMO_ALLOWANCE_UNITS).toBe(1);
    expect(WALL_OF_TEXT_ALLOWANCE_UNITS).toBe(1);
  });
});
