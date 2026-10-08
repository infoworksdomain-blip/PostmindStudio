import { describe, expect, it } from 'vitest';
import { balanceLine, balanceWrap, greedyLines } from './balanced-wrap';

const words = (s: string) => s.split(' ');

describe('greedyLines', () => {
  it('fills each line before starting the next', () => {
    expect(greedyLines(words('aaa bbb ccc ddd'), 7)).toEqual(['aaa bbb', 'ccc ddd']);
  });
});

describe('balanceLine', () => {
  it('does not strand a short word alone on the last line', () => {
    const line =
      'Five reasons our sourdough sells out before the opener, every single day of the week fire';
    const greedy = greedyLines(words(line), 30);
    expect(greedy[greedy.length - 1]).toBe('fire');
    const balanced = balanceLine(line, 30);
    expect(balanced[balanced.length - 1]?.split(' ').length).toBeGreaterThan(1);
  });

  it('uses the same number of lines as the greedy wrap', () => {
    const samples = [
      'Stop scrolling: three things every small bakery should post this week, opener,',
      'Fresh bread daily from six in the morning until we sell out, which is usually by noon',
      'One two three four five six seven eight nine ten eleven twelve thirteen',
    ];
    for (const sample of samples) {
      for (const max of [12, 18, 24, 32]) {
        expect(balanceLine(sample, max)).toHaveLength(greedyLines(words(sample), max).length);
      }
    }
  });

  it('keeps every line within the limit and every word in order', () => {
    const line =
      'Fresh bread daily from six in the morning until we sell out, which is usually by noon';
    const balanced = balanceLine(line, 20);
    for (const l of balanced) expect([...l].length).toBeLessThanOrEqual(20);
    expect(balanced.join(' ')).toBe(line);
  });

  it('evens out the line lengths compared with greedy', () => {
    const line = 'aaaa bbbb cccc dddd ee';
    const spread = (ls: string[]) => {
      const lens = ls.map((l) => l.length);
      return Math.max(...lens) - Math.min(...lens);
    };
    expect(spread(balanceLine(line, 19))).toBeLessThan(spread(greedyLines(words(line), 19)));
  });

  it('cuts a word longer than the limit into pieces, as greedy does', () => {
    const balanced = balanceLine('see https://example.com/a-very-long-path today', 10);
    for (const l of balanced) expect([...l].length).toBeLessThanOrEqual(10);
    expect(balanced.join('').replace(/ /g, '')).toBe(
      'seehttps://example.com/a-very-long-pathtoday',
    );
  });

  it('returns nothing for empty text and one line for one word', () => {
    expect(balanceLine('   ', 20)).toEqual([]);
    expect(balanceLine('Hello', 20)).toEqual(['Hello']);
  });

  it('allows a one-word last line when no other split fits', () => {
    expect(balanceLine('aaaaaaaaaa bbbbbbbbbb c', 12)).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb c']);
    expect(balanceLine('aaaaaaaaaa bbbbbbbbbb', 12)).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb']);
  });
});

describe('balanceWrap', () => {
  it('balances each of the owner lines and keeps their breaks', () => {
    const text = 'Our menu\nSourdough, rye and spelt loaves baked fresh every morning by hand';
    const out = balanceWrap(text, 24).split('\n');
    expect(out[0]).toBe('Our menu');
    expect(out.slice(1).join(' ')).toBe(
      'Sourdough, rye and spelt loaves baked fresh every morning by hand',
    );
    expect(out.slice(1).every((l) => l.split(' ').length > 1)).toBe(true);
  });

  it('returns empty and short text unchanged', () => {
    expect(balanceWrap('', 20)).toBe('');
    expect(balanceWrap('Hello', 20)).toBe('Hello');
  });

  it('leaves text in a script without spaces to the renderer', () => {
    const han = '新鲜面包每天早上六点出炉卖完为止通常在中午之前就卖光了';
    expect(balanceWrap(han, 8)).toBe(han);
  });
});
