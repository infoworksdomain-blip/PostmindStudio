import { describe, expect, it } from 'vitest';
import {
  AUDIO_MIX_LEVELS,
  effectiveLayout,
  HOOK_DEMO_ALLOWANCE_QUARTERS,
  hookDemoCreateInput,
  hookDemoTiming,
  newHookDemoDocument,
  readHookDemo,
} from './hook-demo';
import { allowanceQuartersOf } from '../ugc/allowance';
import {
  NO_BACKGROUND_VIDEO,
  noBackgroundVideo,
  WALL_OF_TEXT_ALLOWANCE_QUARTERS,
  newWallOfTextDocument,
  wallShownSec,
} from './wall-of-text';
import { HOOK_CAPTION_FONT_PCT, hookCaptionStyle, wallTextFontPct } from './caption-style';
import { BUILT_IN_PRESETS } from '../overlays/presets';

describe('22.6 production QA polish', () => {
  it('the hook caption uses the classic hook preset size (4.2 %), not 5.2 %', () => {
    const classic = BUILT_IN_PRESETS.find((p) => p.key === 'hook_tiktok_classic');
    expect(HOOK_CAPTION_FONT_PCT).toBe(4.2);
    expect(classic?.parameters.fontSizePct).toBe(HOOK_CAPTION_FONT_PCT);
    expect(hookCaptionStyle(false).fontSizePct).toBe(4.2);
  });

  it('a block stays on screen long enough to read (3.5 words/s), up to 12 s', () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
    expect(wallShownSec(8, words(20))).toBe(8);
    expect(wallShownSec(8, words(35))).toBe(10);
    expect(wallShownSec(8, words(60))).toBe(12);
    expect(wallShownSec(12, words(10))).toBe(12);
    expect(wallShownSec(8, null)).toBe(8);
    // Longer text gets time, never a smaller font than the length table already gives.
    expect(wallTextFontPct(60)).toBe(3.3);
  });
});
import { ProviderError, RateDeferredError, ValidationError } from '../../errors';

// BACKLOG 22.1 — hook + demo input, stored document, timing and audio mix.

describe('hookDemoCreateInput', () => {
  it('fills the defaults (AI creator, surprised, sequential, balanced, 15 s)', () => {
    expect(hookDemoCreateInput.parse({})).toEqual({
      hookSource: 'ai_creator',
      reaction: 'surprised',
      layout: 'sequential',
      audioMix: 'balanced',
      targetSec: 15,
      allowGeneratedHook: true,
    });
  });

  it('accepts a hook line of up to 9 words (22.6)', () => {
    const hookLine = 'one two three four five six seven eight nine';
    expect(hookDemoCreateInput.parse({ hookLine }).hookLine).toBe(hookLine);
  });

  it.each([
    ['10 words', 'one two three four five six seven eight nine ten'],
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

  it('stacked: the full-frame demo never runs past the end of the file', () => {
    // An 8 s demo: 3 s play under the hook, 5 s are left for the full-frame part.
    expect(hookDemoTiming({ targetSec: 15, demoDurationSec: 8, stacked: true })).toEqual({
      hookSec: 3,
      demoSec: 5,
      totalSec: 8,
    });
    expect(hookDemoTiming({ targetSec: 15, demoDurationSec: 8 })).toMatchObject({ demoSec: 8 });
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

describe('noBackgroundVideo (22.2)', () => {
  it('turns "nothing found / nothing configured" into no_background_video, keeps retryable errors', () => {
    const noMatch = new ProviderError('pixabay', 'invalid_request', 'no match', false);
    expect(noBackgroundVideo(noMatch)).toBeInstanceOf(ValidationError);
    expect((noBackgroundVideo(noMatch) as Error).message).toBe(NO_BACKGROUND_VIDEO);
    const busy = new ProviderError('pixabay', 'rate_limited', 'busy', true);
    expect(noBackgroundVideo(busy)).toBe(busy);
    const deferred = new RateDeferredError('pixabay', 1_000);
    expect(noBackgroundVideo(deferred)).toBe(deferred);
  });
});

describe('allowance quarters (22.1 / 22.2, 23.3)', () => {
  it('a hook + demo video and a wall of text each use a quarter of a video', () => {
    const doc = newHookDemoDocument(hookDemoCreateInput.parse({}), {
      uploadId: 'u',
      assetId: 'a',
    });
    expect(allowanceQuartersOf({ metadata: { hookDemo: doc } })).toBe(HOOK_DEMO_ALLOWANCE_QUARTERS);
    expect(
      allowanceQuartersOf({
        sourceType: 'WALL_OF_TEXT',
        metadata: { wallOfText: newWallOfTextDocument({ background: 'calm', durationSec: 8 }) },
      }),
    ).toBe(WALL_OF_TEXT_ALLOWANCE_QUARTERS);
    expect(HOOK_DEMO_ALLOWANCE_QUARTERS).toBe(1);
    expect(WALL_OF_TEXT_ALLOWANCE_QUARTERS).toBe(1);
  });
});
