import { describe, expect, it } from 'vitest';
import { withWordTiming } from './compose';
import { DEFAULT_STYLE } from './params';
import type { OverlayRow } from './shotstack';

const overlay = (animationIn: OverlayRow['animationIn']): OverlayRow => ({
  ...DEFAULT_STYLE,
  animationIn,
  id: 'o1',
  text: 'Fresh bread',
  startAtSec: 1,
  endAtSec: 3,
});
const words = [
  { text: 'Fresh', startSec: 1.2, endSec: 1.5 },
  { text: 'bread', startSec: 2.0, endSec: 2.4 },
];

describe('withWordTiming (13.6)', () => {
  it('times karaoke overlays from the spoken words', () => {
    expect(withWordTiming(overlay('karaokeHighlight'), words).wordStartsSec).toEqual([0.2, 1]);
  });

  it('leaves other animations and untimed overlays unchanged', () => {
    expect(withWordTiming(overlay('fadeIn'), words).wordStartsSec).toBeUndefined();
    expect(withWordTiming(overlay('karaokeHighlight'), []).wordStartsSec).toBeUndefined();
    expect(withWordTiming(overlay('karaokeHighlight'), undefined).wordStartsSec).toBeUndefined();
  });
});
