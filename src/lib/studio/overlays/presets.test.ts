import { describe, expect, it } from 'vitest';
import { presetParameters, resolveStyle, overlayStyle } from './params';
import { BUILT_IN_PRESETS, PRESET_GROUPS, ROLE_PRESET } from './presets';

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
