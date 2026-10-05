import { describe, expect, it } from 'vitest';
import { presetParameters, resolveStyle, overlayStyle } from './params';
import {
  BUILT_IN_PRESETS,
  PRESET_GROUPS,
  ROLE_PRESET,
  UGC_CAPTION_PRESET,
  UGC_HOOK_PRESET,
} from './presets';

const A4_3_GROUP_NAMES = ['hook', 'subtitle', 'cta', 'quote', 'statistic', 'story', 'brand'];

describe('BUILT_IN_PRESETS', () => {
  it('has at least 25 presets', () => {
    expect(BUILT_IN_PRESETS.length).toBeGreaterThanOrEqual(25);
  });

  it('has unique keys', () => {
    const keys = BUILT_IN_PRESETS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has unique names', () => {
    const names = BUILT_IN_PRESETS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('has every parameters object pass presetParameters validation', () => {
    for (const preset of BUILT_IN_PRESETS) {
      const result = presetParameters.safeParse(preset.parameters);
      expect(result.success, `${preset.key} parameters invalid`).toBe(true);
    }
  });

  it('has resolveStyle(...parameters) pass full overlayStyle validation for every preset', () => {
    for (const preset of BUILT_IN_PRESETS) {
      const resolved = resolveStyle(preset.parameters);
      const result = overlayStyle.safeParse(resolved);
      expect(result.success, `${preset.key} resolved style invalid`).toBe(true);
    }
  });

  it('accepts the pill radius used by Pulse Button and Percentage Ring', () => {
    for (const key of ['cta_pulse_button', 'stat_percentage_ring']) {
      const preset = BUILT_IN_PRESETS.find((p) => p.key === key);
      expect(presetParameters.safeParse(preset?.parameters).success).toBe(true);
    }
  });

  it('covers all 7 A4.3 groups', () => {
    const groups = new Set(BUILT_IN_PRESETS.map((p) => p.group));
    for (const name of A4_3_GROUP_NAMES) {
      expect(groups.has(name as (typeof PRESET_GROUPS)[number])).toBe(true);
    }
  });

  it('matches PRESET_GROUPS exactly', () => {
    expect([...PRESET_GROUPS].sort()).toEqual([...A4_3_GROUP_NAMES].sort());
  });

  it('only uses groups declared in PRESET_GROUPS', () => {
    for (const preset of BUILT_IN_PRESETS) {
      expect(PRESET_GROUPS).toContain(preset.group);
    }
  });

  it('gives every preset a boolean brandSubstitution flag', () => {
    for (const preset of BUILT_IN_PRESETS) {
      expect(typeof preset.brandSubstitution).toBe('boolean');
    }
  });

  it('gives every preset a non-empty name', () => {
    for (const preset of BUILT_IN_PRESETS) {
      expect(preset.name.length).toBeGreaterThan(0);
    }
  });
});

describe('TikTok classic presets for UGC videos (21.4b)', () => {
  const byKey = (key: string) => BUILT_IN_PRESETS.find((p) => p.key === key);

  it('captions: white, thin black outline, no box or shadow, small, lower-middle, no fades', () => {
    const preset = byKey(UGC_CAPTION_PRESET);
    expect(preset?.group).toBe('subtitle');
    expect(preset?.brandSubstitution).toBe(false);
    const style = resolveStyle(preset?.parameters);
    expect(style).toMatchObject({
      fillColor: '#FFFFFF',
      strokeColor: '#000000',
      strokeWidthPx: 3,
      shadowColor: null,
      backgroundType: 'none',
      backgroundColor: null,
      fontSizePct: 3.6,
      anchorY: 0.7,
      animationIn: 'none',
      animationOut: 'none',
    });
    expect(style.fontWeight).toBeGreaterThanOrEqual(700);
    expect(style.fontWeight).toBeLessThanOrEqual(800);
  });

  it('hook: the same look, a little larger, in the top band', () => {
    const preset = byKey(UGC_HOOK_PRESET);
    expect(preset?.group).toBe('hook');
    expect(preset?.brandSubstitution).toBe(false);
    expect(resolveStyle(preset?.parameters)).toMatchObject({
      backgroundType: 'none',
      strokeColor: '#000000',
      fillColor: '#FFFFFF',
      fontSizePct: 4.2,
      anchorY: 0.11,
    });
  });

  it('ordinary videos keep their role presets', () => {
    expect(ROLE_PRESET).toEqual({
      hook: 'hook_tiktok_native',
      body: 'subtitle_box',
      cta: 'cta_pulse_button',
    });
  });
});

describe('ROLE_PRESET', () => {
  it('defines hook, body and cta roles', () => {
    expect(Object.keys(ROLE_PRESET).sort()).toEqual(['body', 'cta', 'hook']);
  });

  it('references preset keys that exist in BUILT_IN_PRESETS', () => {
    const keys = new Set(BUILT_IN_PRESETS.map((p) => p.key));
    expect(keys.has(ROLE_PRESET.hook)).toBe(true);
    expect(keys.has(ROLE_PRESET.body)).toBe(true);
    expect(keys.has(ROLE_PRESET.cta)).toBe(true);
  });
});
