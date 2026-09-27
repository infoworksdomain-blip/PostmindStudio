import { describe, expect, it } from 'vitest';
import {
  applyBrand,
  DEFAULT_STYLE,
  overlayStyle,
  overlayStyleFromRow,
  overlayText,
  overlayTiming,
  presetParameters,
  resolveStyle,
  type OverlayStyle,
} from './params';

function validStyle(overrides: Partial<OverlayStyle> = {}): OverlayStyle {
  return { ...DEFAULT_STYLE, ...overrides };
}

describe('overlayStyle', () => {
  it('accepts the default style', () => {
    expect(overlayStyle.safeParse(validStyle()).success).toBe(true);
  });

  it('accepts a #RRGGBB colour', () => {
    expect(overlayStyle.safeParse(validStyle({ fillColor: '#FFFFFF' })).success).toBe(true);
  });

  it('accepts a #RRGGBBAA colour', () => {
    expect(overlayStyle.safeParse(validStyle({ fillColor: '#FFFFFF80' })).success).toBe(true);
  });

  it('rejects a colour missing the leading #', () => {
    expect(overlayStyle.safeParse(validStyle({ fillColor: 'FFFFFF' })).success).toBe(false);
  });

  it('rejects a colour with the wrong number of hex digits', () => {
    expect(overlayStyle.safeParse(validStyle({ fillColor: '#FFF' })).success).toBe(false);
  });

  it('rejects a colour with non-hex characters', () => {
    expect(overlayStyle.safeParse(validStyle({ fillColor: '#GGFFFF' })).success).toBe(false);
  });

  it('rejects a font family containing quotes', () => {
    expect(overlayStyle.safeParse(validStyle({ fontFamily: `Evil"Font` })).success).toBe(false);
  });

  it('rejects a font family containing a semicolon', () => {
    expect(overlayStyle.safeParse(validStyle({ fontFamily: 'Evil;Font' })).success).toBe(false);
  });

  it('accepts a font family with letters, digits, spaces and hyphens', () => {
    expect(overlayStyle.safeParse(validStyle({ fontFamily: 'Roboto Mono-2' })).success).toBe(true);
  });

  it('rejects an empty font family', () => {
    expect(overlayStyle.safeParse(validStyle({ fontFamily: '' })).success).toBe(false);
  });

  it('rejects a font family longer than 64 characters', () => {
    expect(overlayStyle.safeParse(validStyle({ fontFamily: 'A'.repeat(65) })).success).toBe(false);
  });

  it('accepts font weights that are multiples of 100', () => {
    expect(overlayStyle.safeParse(validStyle({ fontWeight: 100 })).success).toBe(true);
    expect(overlayStyle.safeParse(validStyle({ fontWeight: 900 })).success).toBe(true);
  });

  it('rejects font weights that are not multiples of 100', () => {
    expect(overlayStyle.safeParse(validStyle({ fontWeight: 150 })).success).toBe(false);
  });

  it('rejects font weights below 100', () => {
    expect(overlayStyle.safeParse(validStyle({ fontWeight: 0 })).success).toBe(false);
  });

  it('rejects font weights above 900', () => {
    expect(overlayStyle.safeParse(validStyle({ fontWeight: 1000 })).success).toBe(false);
  });

  it('rejects a fontSizePct below the minimum', () => {
    expect(overlayStyle.safeParse(validStyle({ fontSizePct: 0 })).success).toBe(false);
  });

  it('rejects a fontSizePct above the maximum', () => {
    expect(overlayStyle.safeParse(validStyle({ fontSizePct: 41 })).success).toBe(false);
  });

  it('accepts fontSizePct at the boundaries', () => {
    expect(overlayStyle.safeParse(validStyle({ fontSizePct: 1 })).success).toBe(true);
    expect(overlayStyle.safeParse(validStyle({ fontSizePct: 40 })).success).toBe(true);
  });

  it('accepts a null strokeColor', () => {
    expect(overlayStyle.safeParse(validStyle({ strokeColor: null })).success).toBe(true);
  });

  it('rejects an out-of-range rotationDeg', () => {
    expect(overlayStyle.safeParse(validStyle({ rotationDeg: 181 })).success).toBe(false);
  });

  it('accepts rotationDeg at the boundaries', () => {
    expect(overlayStyle.safeParse(validStyle({ rotationDeg: -180 })).success).toBe(true);
    expect(overlayStyle.safeParse(validStyle({ rotationDeg: 180 })).success).toBe(true);
  });

  it('rejects an unknown effect key', () => {
    const result = overlayStyle.safeParse(
      validStyle({ effect: { unknownField: 1 } as unknown as OverlayStyle['effect'] }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level key (strict object)', () => {
    const result = overlayStyle.safeParse({ ...validStyle(), extraField: 'nope' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid animation name', () => {
    expect(
      overlayStyle.safeParse(validStyle({ animationIn: 'spin' as OverlayStyle['animationIn'] }))
        .success,
    ).toBe(false);
  });
});

describe('overlayStyleFromRow', () => {
  it('parses successfully even when the row carries extra database columns', () => {
    const row = { ...validStyle(), id: 'row-1', text: 'hello', createdAt: new Date() };
    const result = overlayStyleFromRow.safeParse(row);
    expect(result.success).toBe(true);
  });

  it('does not include the extra keys in the parsed output', () => {
    const row = { ...validStyle(), id: 'row-1', text: 'hello' };
    const result = overlayStyleFromRow.parse(row);
    expect(result).not.toHaveProperty('id');
    expect(result).not.toHaveProperty('text');
  });

  it('still rejects invalid values in the known fields', () => {
    const row = { ...validStyle(), fillColor: 'not-a-colour', id: 'row-1' };
    expect(overlayStyleFromRow.safeParse(row).success).toBe(false);
  });
});

describe('overlayTiming', () => {
  it('accepts endAtSec after startAtSec', () => {
    expect(overlayTiming.safeParse({ startAtSec: 1, endAtSec: 2 }).success).toBe(true);
  });

  it('rejects endAtSec equal to startAtSec', () => {
    expect(overlayTiming.safeParse({ startAtSec: 1, endAtSec: 1 }).success).toBe(false);
  });

  it('rejects endAtSec before startAtSec', () => {
    expect(overlayTiming.safeParse({ startAtSec: 2, endAtSec: 1 }).success).toBe(false);
  });

  it('rejects a startAtSec beyond the maximum', () => {
    expect(overlayTiming.safeParse({ startAtSec: 3_601, endAtSec: 3_602 }).success).toBe(false);
  });

  it('rejects a negative startAtSec', () => {
    expect(overlayTiming.safeParse({ startAtSec: -1, endAtSec: 1 }).success).toBe(false);
  });
});

describe('overlayText', () => {
  it('accepts text without a lang tag', () => {
    expect(overlayText.safeParse({ text: 'Hello world' }).success).toBe(true);
  });

  it('accepts a simple 2-letter BCP 47 lang tag', () => {
    expect(overlayText.safeParse({ text: 'Hola', lang: 'es' }).success).toBe(true);
  });

  it('accepts a region-qualified BCP 47 lang tag', () => {
    expect(overlayText.safeParse({ text: 'Hi', lang: 'en-GB' }).success).toBe(true);
  });

  it('accepts a 3-letter primary language subtag', () => {
    expect(overlayText.safeParse({ text: 'Hi', lang: 'yue-HK' }).success).toBe(true);
  });

  it('rejects a malformed lang tag', () => {
    expect(overlayText.safeParse({ text: 'Hi', lang: 'not_a_tag!' }).success).toBe(false);
  });

  it('rejects empty text', () => {
    expect(overlayText.safeParse({ text: '' }).success).toBe(false);
  });

  it('rejects text over 500 characters', () => {
    expect(overlayText.safeParse({ text: 'a'.repeat(501) }).success).toBe(false);
  });

  it('trims whitespace-only text down to empty and rejects it', () => {
    expect(overlayText.safeParse({ text: '   ' }).success).toBe(false);
  });
});

describe('presetParameters', () => {
  it('accepts an empty object (fully optional)', () => {
    expect(presetParameters.safeParse({}).success).toBe(true);
  });

  it('accepts a partial set of fields', () => {
    expect(presetParameters.safeParse({ fontFamily: 'Inter', fontWeight: 700 }).success).toBe(true);
  });

  it('still validates the fields that are present', () => {
    expect(presetParameters.safeParse({ fontWeight: 150 }).success).toBe(false);
  });
});

describe('resolveStyle', () => {
  it('returns DEFAULT_STYLE when given no layers', () => {
    expect(resolveStyle()).toEqual(DEFAULT_STYLE);
  });

  it('ignores null and undefined layers', () => {
    expect(resolveStyle(null, undefined)).toEqual(DEFAULT_STYLE);
  });

  it('layers a partial preset over the default style', () => {
    const result = resolveStyle({ fontFamily: 'Anton' });
    expect(result.fontFamily).toBe('Anton');
    expect(result.fontWeight).toBe(DEFAULT_STYLE.fontWeight);
  });

  it('applies later layers over earlier ones', () => {
    const result = resolveStyle({ fontFamily: 'Anton' }, { fontFamily: 'Inter' });
    expect(result.fontFamily).toBe('Inter');
  });

  it('does not mutate DEFAULT_STYLE', () => {
    resolveStyle({ fontFamily: 'Anton' });
    expect(DEFAULT_STYLE.fontFamily).toBe('Montserrat');
  });
});

describe('applyBrand', () => {
  it('returns the style unchanged when brand is null', () => {
    const style = validStyle();
    expect(applyBrand(style, null)).toBe(style);
  });

  it('substitutes the brand font family when valid', () => {
    const result = applyBrand(validStyle(), { fontFamily: 'Poppins' });
    expect(result.fontFamily).toBe('Poppins');
  });

  it('ignores an invalid brand font family', () => {
    const result = applyBrand(validStyle(), { fontFamily: 'Bad;Font' });
    expect(result.fontFamily).toBe(DEFAULT_STYLE.fontFamily);
  });

  it('substitutes fillColor from brand.secondary', () => {
    const result = applyBrand(validStyle(), { secondary: '#123456' });
    expect(result.fillColor).toBe('#123456');
  });

  it('ignores an invalid brand.secondary colour', () => {
    const result = applyBrand(validStyle(), { secondary: 'not-a-colour' });
    expect(result.fillColor).toBe(DEFAULT_STYLE.fillColor);
  });

  it('substitutes backgroundColor from brand.primary when backgroundType is not none', () => {
    const style = validStyle({ backgroundType: 'box', backgroundColor: '#000000' });
    const result = applyBrand(style, { primary: '#ABCDEF' });
    expect(result.backgroundColor).toBe('#ABCDEF');
  });

  it('keeps backgroundColor absent when backgroundType is none, even with a valid brand.primary', () => {
    const style = validStyle({ backgroundType: 'none', backgroundColor: null });
    const result = applyBrand(style, { primary: '#ABCDEF' });
    expect(result.backgroundColor).toBeNull();
  });

  it('substitutes strokeColor from brand.primary only when the style already has a strokeColor', () => {
    const style = validStyle({ strokeColor: '#000000' });
    const result = applyBrand(style, { primary: '#ABCDEF' });
    expect(result.strokeColor).toBe('#ABCDEF');
  });

  it('leaves strokeColor null when the style has no strokeColor', () => {
    const style = validStyle({ strokeColor: null });
    const result = applyBrand(style, { primary: '#ABCDEF' });
    expect(result.strokeColor).toBeNull();
  });

  it('ignores an invalid brand.primary colour (with alpha channel, not accepted here)', () => {
    const style = validStyle({ backgroundType: 'box', backgroundColor: '#000000' });
    const result = applyBrand(style, { primary: '#ABCDEF80' });
    expect(result.backgroundColor).toBe('#000000');
  });

  it('applies font, fill and background substitutions together', () => {
    const style = validStyle({ backgroundType: 'box', backgroundColor: '#000000' });
    const result = applyBrand(style, {
      primary: '#111111',
      secondary: '#222222',
      fontFamily: 'Lato',
    });
    expect(result).toMatchObject({
      fontFamily: 'Lato',
      fillColor: '#222222',
      backgroundColor: '#111111',
    });
  });
});
