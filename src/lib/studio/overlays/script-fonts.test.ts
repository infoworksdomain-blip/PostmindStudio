import { describe, expect, it } from 'vitest';
import {
  RIGHT_TO_LEFT_MARK,
  directionalText,
  overlayTypography,
  scriptFontFiles,
  withScriptTypography,
} from './script-fonts';

describe('overlayTypography', () => {
  it('sets Arabic in Noto Sans Arabic, right-to-left', () => {
    expect(overlayTypography('ar', 'Montserrat')).toEqual({
      fontFamily: 'Noto Sans Arabic',
      direction: 'rtl',
    });
  });

  it('sets Hindi in Noto Sans Devanagari and Mandarin in Noto Sans SC, left-to-right', () => {
    expect(overlayTypography('hi', 'Montserrat')).toEqual({
      fontFamily: 'Noto Sans Devanagari',
      direction: 'ltr',
    });
    expect(overlayTypography('zh-Hans', 'Montserrat')).toEqual({
      fontFamily: 'Noto Sans SC',
      direction: 'ltr',
    });
  });

  it.each(['en-GB', 'en-US', 'fr', 'es', 'de', 'it', 'pt-BR', 'pt-PT'])(
    'keeps the brand font for Latin-script %s',
    (lang) => {
      expect(overlayTypography(lang, 'Montserrat')).toEqual({
        fontFamily: 'Montserrat',
        direction: 'ltr',
      });
    },
  );
});

describe('withScriptTypography', () => {
  const overlay = { id: 'o', fontFamily: 'Anton', text: 'x' };

  it('returns the same object for Latin languages and unknown or missing tags', () => {
    expect(withScriptTypography(overlay, 'fr')).toBe(overlay);
    expect(withScriptTypography(overlay, 'xx-YY')).toBe(overlay);
    expect(withScriptTypography(overlay, null)).toBe(overlay);
  });

  it('returns a new overlay with the script font and direction without mutating the input', () => {
    const result = withScriptTypography(overlay, 'AR');
    expect(result).toEqual({ ...overlay, fontFamily: 'Noto Sans Arabic', direction: 'rtl' });
    expect(overlay.fontFamily).toBe('Anton');
  });
});

describe('directionalText', () => {
  it('prefixes RTL text with a single right-to-left mark', () => {
    expect(directionalText('Nike مرحبا', 'rtl')).toBe(`${RIGHT_TO_LEFT_MARK}Nike مرحبا`);
    expect(directionalText(`${RIGHT_TO_LEFT_MARK}مرحبا`, 'rtl')).toBe(`${RIGHT_TO_LEFT_MARK}مرحبا`);
  });

  it('leaves LTR and unspecified text unchanged', () => {
    expect(directionalText('Hello', 'ltr')).toBe('Hello');
    expect(directionalText('Hello', undefined)).toBe('Hello');
  });
});

describe('scriptFontFiles', () => {
  it('lists the hosted file names for the non-Latin scripts', () => {
    expect(scriptFontFiles()).toEqual([
      'NotoSansArabic.ttf',
      'NotoSansDevanagari.ttf',
      'NotoSansSC.ttf',
    ]);
  });
});
