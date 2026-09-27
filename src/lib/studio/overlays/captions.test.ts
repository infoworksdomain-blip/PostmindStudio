import { describe, expect, it } from 'vitest';
import { CAPTION_PRESET_KEY, captionLines, captionRows } from './captions';

const w = (text: string, startSec: number, endSec: number) => ({ text, startSec, endSec });

describe('captionLines', () => {
  it('breaks at sentence ends and keeps lines short', () => {
    const lines = captionLines(
      [
        w('Welcome', 0.1, 0.4),
        w('to', 0.4, 0.5),
        w('the', 0.5, 0.6),
        w('shop.', 0.6, 0.9),
        w('We', 1.2, 1.3),
        w('bake', 1.3, 1.6),
        w('every', 1.6, 1.9),
        w('single', 1.9, 2.2),
        w('morning', 2.2, 2.5),
        w('from', 2.5, 2.7),
        w('five', 2.7, 3.0),
        w('sharp', 3.0, 3.3),
      ],
      30,
    );
    expect(lines.map((l) => l.text)).toEqual([
      'Welcome to the shop.',
      'We bake every single morning from five',
      'sharp',
    ]);
    expect(lines[0]).toMatchObject({ startAtSec: 0.1, endAtSec: 0.9 });
  });

  it('splits lines longer than the time limit and never overlaps them', () => {
    const lines = captionLines([w('slow', 0, 0.5), w('words', 4, 4.2)], 30);
    expect(lines).toHaveLength(2);
    for (let i = 1; i < lines.length; i += 1)
      expect(lines[i - 1]?.endAtSec).toBeLessThanOrEqual(lines[i]?.startAtSec ?? 0);
  });

  it('drops words past the shot end and clamps to it', () => {
    const lines = captionLines([w('in', 1, 1.2), w('out', 12, 12.3)], 5);
    expect(lines.map((l) => l.text)).toEqual(['in']);
    expect(captionLines([w('edge', 4.9, 5.4)], 5)[0]?.endAtSec).toBe(5);
    expect(captionLines([], 5)).toEqual([]);
  });
});

describe('captionRows', () => {
  it('styles each line with the subtitle preset for the shot', () => {
    const rows = captionRows(
      'shot-1',
      [{ text: 'Hello', startAtSec: 0, endAtSec: 1 }],
      { primary: '#112233' },
      new Map([['Box Background', 'preset-id']]),
    );
    expect(CAPTION_PRESET_KEY).toBe('subtitle_box');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      shotId: 'shot-1',
      text: 'Hello',
      presetId: 'preset-id',
      startAtSec: 0,
      endAtSec: 1,
    });
    expect(typeof rows[0]?.fontFamily).toBe('string');
  });
});
