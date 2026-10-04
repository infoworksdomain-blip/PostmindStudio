import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../pipeline/edl-backdrop';
import { onScreenTextPlacement, TOP_HEADLINE_OFFSET_Y } from '../pipeline/edl';
import { applyBrand, DEFAULT_STYLE, withReadableText } from './params';
import { showsOwnText, withoutOnScreenDuplicates } from './voice-captions';

// Production QA run 9 (2026-10-04): unreadable caption and hook boxes, a headline drawn over the
// narration captions, and a motion card's text repeated as a caption.

const boxed = { ...DEFAULT_STYLE, backgroundType: 'box' as const, backgroundColor: '#111111' };

describe('readable overlay text', () => {
  it('replaces a brand text colour that does not contrast with the brand box', () => {
    // Near-black primary (box) and dark-navy secondary (text), as on the operator's brand kit.
    const style = applyBrand(boxed, { primary: '#0B0B0F', secondary: '#1B2A4A' });
    expect(style.backgroundColor).toBe('#0B0B0F');
    expect(contrastRatio(style.fillColor, '#0B0B0F')).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps a brand text colour that already reads clearly', () => {
    const style = applyBrand(boxed, { primary: '#0B0B0F', secondary: '#F5D547' });
    expect(style.fillColor).toBe('#F5D547');
  });

  it('leaves text with no box alone', () => {
    const plain = { ...DEFAULT_STYLE, backgroundType: 'none' as const, fillColor: '#222222' };
    expect(withReadableText(plain)).toBe(plain);
  });
});

describe('headline placement', () => {
  it('moves a voiced shot’s headline to the top so it never covers the narration captions', () => {
    expect(onScreenTextPlacement(true)).toEqual({
      position: 'top',
      offset: { x: 0, y: TOP_HEADLINE_OFFSET_Y },
    });
    expect(onScreenTextPlacement(false)).toEqual({ position: 'bottom' });
  });
});

describe('cards that show their own text', () => {
  it('treats motion-graphics cards like text cards, so their text is not captioned again', () => {
    expect(showsOwnText('MOTION_GRAPHICS')).toBe(true);
    expect(showsOwnText('TEXT_CARD')).toBe(true);
    expect(showsOwnText('AI_CLIP')).toBe(false);
    const lines = withoutOnScreenDuplicates(
      [{ text: 'Sound familiar?', startAtSec: 0.1, endAtSec: 1.2 }],
      [{ text: 'Sound familiar?', startAtSec: 0, endAtSec: 2.2 }],
    );
    expect(lines).toEqual([]);
  });
});
