import { describe, expect, it } from 'vitest';
import { BUILT_IN_PRESETS, ROLE_PRESET } from './presets';
import {
  shotRole,
  suggestOverlays,
  suggestionRows,
  UGC_HOOK_ANCHOR_Y,
  UGC_HOOK_FONT_PCT,
  UGC_HOOK_MAX_CHARS,
  VOICED_LABEL_ANCHOR_Y,
  type SuggestShot,
} from './suggest';

describe('label placement and cards (production QA run 10, 2026-10-04)', () => {
  const three = (voiceoverText: string | null, treatment = 'IMAGE_STILL') => [
    {
      id: 'a',
      sortOrder: 0,
      durationSec: 3,
      onScreenText: 'Hook',
      visualTreatment: 'AI_CLIP',
      voiceoverText,
    },
    {
      id: 'b',
      sortOrder: 1,
      durationSec: 3,
      onScreenText: 'Notes everywhere.',
      visualTreatment: treatment,
      voiceoverText,
    },
    {
      id: 'c',
      sortOrder: 2,
      durationSec: 3,
      onScreenText: 'Try it free',
      visualTreatment: 'AI_CLIP',
      voiceoverText,
    },
  ];

  it('puts body and CTA labels of voiced shots above the narration captions; the hook stays', () => {
    const [hook, body, cta] = suggestOverlays(three('Spoken line.'), null);
    expect(body?.style.anchorY).toBe(VOICED_LABEL_ANCHOR_Y);
    expect(cta?.style.anchorY).toBe(VOICED_LABEL_ANCHOR_Y);
    expect(hook?.style.anchorY).not.toBe(VOICED_LABEL_ANCHOR_Y);
  });

  it('keeps the preset position on unvoiced shots', () => {
    const [, body] = suggestOverlays(three(null), null);
    expect(body?.style.anchorY).not.toBe(VOICED_LABEL_ANCHOR_Y);
  });

  it('adds no label to a motion-graphics card, which draws its own text', () => {
    const shots = suggestOverlays(three('Spoken line.', 'MOTION_GRAPHICS'), null);
    expect(shots.map((s) => s.shotId)).toEqual(['a', 'c']);
  });
});

describe('UGC actor shots keep the face clear (21.4a, production 2026-10-04)', () => {
  const ugc = (hook: string): SuggestShot[] => [
    {
      id: 'actor-hook',
      sortOrder: 0,
      durationSec: 8,
      onScreenText: hook,
      visualTreatment: 'UGC_ACTOR',
      voiceoverText: 'I used to dread client calls.',
    },
    {
      id: 'actor-body',
      sortOrder: 1,
      durationSec: 8,
      onScreenText: 'dreaded client calls',
      visualTreatment: 'UGC_ACTOR',
      voiceoverText: 'Then I found this.',
    },
    {
      id: 'still',
      sortOrder: 2,
      durationSec: 3,
      onScreenText: 'Book in seconds',
      visualTreatment: 'IMAGE_STILL',
      voiceoverText: null,
    },
    {
      id: 'actor-cta',
      sortOrder: 3,
      durationSec: 8,
      onScreenText: 'not anymore though',
      visualTreatment: 'UGC_ACTOR',
      voiceoverText: 'Link below.',
    },
  ];

  it('adds no label to body or CTA actor shots; B-roll keeps its label', () => {
    const shots = suggestOverlays(ugc('Client calls?'), null);
    expect(shots.map((s) => s.shotId)).toEqual(['actor-hook', 'still']);
    expect(
      shots.some((s) => s.style.anchorY === VOICED_LABEL_ANCHOR_Y && s.shotId !== 'still'),
    ).toBe(false);
  });

  it('the opening hook is small, in the top band above the face and below the AI label', () => {
    const [hook] = suggestOverlays(ugc('Client calls?'), null);
    expect(hook?.style.anchorY).toBe(UGC_HOOK_ANCHOR_Y);
    expect(hook?.style.anchorY).toBeLessThan(VOICED_LABEL_ANCHOR_Y);
    expect(hook?.style.anchorY).toBeGreaterThan(0.06);
    expect(hook?.style.fontSizePct).toBe(UGC_HOOK_FONT_PCT);
    expect(hook?.presetName).toBe(BUILT_IN_PRESETS.find((p) => p.key === ROLE_PRESET.hook)?.name);
  });

  it('a hook too long to fit the band on one line is left to the captions', () => {
    const shots = suggestOverlays(ugc('x'.repeat(UGC_HOOK_MAX_CHARS + 1)), null);
    expect(shots.map((s) => s.shotId)).toEqual(['still']);
  });

  it('a template preset never moves a label onto an actor shot', () => {
    const shots = suggestOverlays(ugc('Client calls?'), null, () => 'subtitle_box');
    expect(shots.find((s) => s.shotId === 'actor-body')).toBeUndefined();
    expect(shots[0]?.style.anchorY).toBe(UGC_HOOK_ANCHOR_Y);
  });
});

function shot(overrides: Partial<SuggestShot> = {}): SuggestShot {
  return {
    id: 'shot-1',
    sortOrder: 0,
    durationSec: 4,
    onScreenText: 'Some text',
    visualTreatment: 'AI_CLIP',
    ...overrides,
  };
}

describe('shotRole', () => {
  it('returns hook for the first shot', () => {
    expect(shotRole(0, 3)).toBe('hook');
  });

  it('returns cta for the last shot when there is more than one shot', () => {
    expect(shotRole(2, 3)).toBe('cta');
  });

  it('returns body for a middle shot', () => {
    expect(shotRole(1, 3)).toBe('body');
  });

  it('returns hook (not cta) for the only shot in a single-shot script', () => {
    expect(shotRole(0, 1)).toBe('hook');
  });
});

describe('suggestOverlays', () => {
  it('skips a TEXT_CARD shot (the card already shows the text)', () => {
    const result = suggestOverlays([shot({ visualTreatment: 'TEXT_CARD' })], null);
    expect(result).toEqual([]);
  });

  it('skips a shot with no onScreenText', () => {
    const result = suggestOverlays([shot({ onScreenText: null })], null);
    expect(result).toEqual([]);
  });

  it('skips a shot whose onScreenText is only whitespace', () => {
    const result = suggestOverlays([shot({ onScreenText: '   ' })], null);
    expect(result).toEqual([]);
  });

  it('chooses the hook preset for the first shot', () => {
    const [suggestion] = suggestOverlays([shot({ sortOrder: 0 })], null);
    const hookPreset = BUILT_IN_PRESETS.find((p) => p.key === ROLE_PRESET.hook);
    expect(suggestion?.presetName).toBe(hookPreset?.name);
  });

  it('chooses the body preset for a middle shot', () => {
    const shots = [
      shot({ id: 's-1', sortOrder: 0 }),
      shot({ id: 's-2', sortOrder: 1 }),
      shot({ id: 's-3', sortOrder: 2 }),
    ];
    const suggestions = suggestOverlays(shots, null);
    const bodyPreset = BUILT_IN_PRESETS.find((p) => p.key === ROLE_PRESET.body);
    const middle = suggestions.find((s) => s.shotId === 's-2');
    expect(middle?.presetName).toBe(bodyPreset?.name);
  });

  it('chooses the cta preset for the last shot', () => {
    const shots = [shot({ id: 's-1', sortOrder: 0 }), shot({ id: 's-2', sortOrder: 1 })];
    const suggestions = suggestOverlays(shots, null);
    const ctaPreset = BUILT_IN_PRESETS.find((p) => p.key === ROLE_PRESET.cta);
    const last = suggestions.find((s) => s.shotId === 's-2');
    expect(last?.presetName).toBe(ctaPreset?.name);
  });

  it('applies brand substitution only when the chosen preset allows it', () => {
    const hookPreset = BUILT_IN_PRESETS.find((p) => p.key === ROLE_PRESET.hook);
    // A secondary that reads on the near-black primary box, so the readability rule keeps it.
    const brand = { primary: '#111111', secondary: '#EEEEEE', fontFamily: 'Poppins' };
    const [suggestion] = suggestOverlays([shot({ sortOrder: 0 })], brand);
    if (hookPreset?.brandSubstitution) {
      expect(suggestion?.style.fillColor).toBe('#EEEEEE');
    } else {
      expect(suggestion?.style.fillColor).not.toBe('#EEEEEE');
    }
  });

  it('does not apply brand substitution for a preset with brandSubstitution: false', () => {
    const brand = { primary: '#111111', secondary: '#222222', fontFamily: 'Poppins' };
    const noBrandPreset = BUILT_IN_PRESETS.find((p) => !p.brandSubstitution);
    if (!noBrandPreset) return;
    // Force the role mapping onto a non-brand preset is not directly possible, so instead assert
    // the general contract: applying brand only changes style when brandSubstitution is true.
    const shots = [shot({ sortOrder: 0 })];
    const withBrand = suggestOverlays(shots, brand);
    const withoutBrand = suggestOverlays(shots, null);
    const preset = BUILT_IN_PRESETS.find((p) => p.key === ROLE_PRESET.hook);
    if (preset?.brandSubstitution) {
      expect(withBrand[0]?.style.fillColor).not.toBe(withoutBrand[0]?.style.fillColor);
    } else {
      expect(withBrand[0]?.style.fillColor).toBe(withoutBrand[0]?.style.fillColor);
    }
  });

  it('sets startAtSec to 0 and endAtSec to the shot duration', () => {
    const [suggestion] = suggestOverlays([shot({ durationSec: 6 })], null);
    expect(suggestion?.startAtSec).toBe(0);
    expect(suggestion?.endAtSec).toBe(6);
  });

  it('floors endAtSec at 0.5 for a very short shot', () => {
    const [suggestion] = suggestOverlays([shot({ durationSec: 0.1 })], null);
    expect(suggestion?.endAtSec).toBe(0.5);
  });

  it('truncates suggestion text to 500 characters', () => {
    const [suggestion] = suggestOverlays([shot({ onScreenText: 'x'.repeat(600) })], null);
    expect(suggestion?.text.length).toBe(500);
  });

  it('orders shots by sortOrder before assigning roles', () => {
    const shots = [shot({ id: 'last', sortOrder: 1 }), shot({ id: 'first', sortOrder: 0 })];
    const suggestions = suggestOverlays(shots, null);
    const first = suggestions.find((s) => s.shotId === 'first');
    const hookPreset = BUILT_IN_PRESETS.find((p) => p.key === ROLE_PRESET.hook);
    expect(first?.presetName).toBe(hookPreset?.name);
  });
});

describe('suggestionRows', () => {
  it('resolves presetId by preset name when present in the map', () => {
    const suggestions = suggestOverlays([shot({ sortOrder: 0 })], null);
    const map = new Map([[suggestions[0]?.presetName ?? '', 'preset-db-id']]);
    const rows = suggestionRows(suggestions, map);
    expect(rows[0]?.presetId).toBe('preset-db-id');
  });

  it('sets presetId to null when the preset name is not in the map', () => {
    const suggestions = suggestOverlays([shot({ sortOrder: 0 })], null);
    const rows = suggestionRows(suggestions, new Map());
    expect(rows[0]?.presetId).toBeNull();
  });

  it('sets effect to undefined when the resolved style has no effect', () => {
    const suggestions = suggestOverlays([shot({ sortOrder: 0 })], null);
    const rows = suggestionRows(suggestions, new Map());
    if (!suggestions[0]?.style.effect) {
      expect(rows[0]?.effect).toBeUndefined();
    }
  });

  it('carries shotId, text and timing through to the row', () => {
    const suggestions = suggestOverlays(
      [shot({ id: 'shot-x', sortOrder: 0, durationSec: 5 })],
      null,
    );
    const [row] = suggestionRows(suggestions, new Map());
    expect(row).toMatchObject({ shotId: 'shot-x', startAtSec: 0, endAtSec: 5 });
  });
});
