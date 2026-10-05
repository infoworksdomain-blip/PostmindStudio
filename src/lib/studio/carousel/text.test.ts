import { describe, expect, it } from 'vitest';
import {
  cleanSlideText,
  layoutTextBlock,
  parseParagraphs,
  visibleLength,
  wrapLine,
  type MeasureText,
} from './text';

/** Every character is half the font size wide. */
const measure: MeasureText = (text, fontSize) => [...text].length * fontSize * 0.5;
const width = (s: string) => measure(s, 10);
const all = () => true;

describe('cleanSlideText', () => {
  it('removes emoji (with joiners and variation selectors) and counts them', () => {
    const out = cleanSlideText('Hi 😀 there 👩‍🍳 ❤️ → ok', all);
    expect(out.text).toBe('Hi there → ok');
    expect(out.removed).toBeGreaterThanOrEqual(3);
  });

  it('drops characters no font in the stack covers, keeps arrows and newlines', () => {
    const covered = (cp: number) => cp !== 0x2603; // no snowman glyph
    expect(cleanSlideText('a☃b\n\n→ c', covered)).toEqual({ text: 'ab\n\n→ c', removed: 1 });
  });

  it('normalises line endings, tabs, trailing spaces and long blank runs', () => {
    expect(cleanSlideText('one  \r\n\r\n\r\n\ttwo', all).text).toBe('one\n\n two');
  });
});

describe('parseParagraphs', () => {
  it('splits paragraphs on blank lines and turns arrow / dash / dot starts into bullets', () => {
    expect(parseParagraphs('Intro\n→ one\n- two\n• three\n\nOutro')).toEqual([
      [
        { text: 'Intro', bullet: false },
        { text: 'one', bullet: true },
        { text: 'two', bullet: true },
        { text: 'three', bullet: true },
      ],
      [{ text: 'Outro', bullet: false }],
    ]);
  });

  it('does not treat a hyphenated word as a bullet', () => {
    expect(parseParagraphs('well-known')[0]?.[0]).toEqual({ text: 'well-known', bullet: false });
  });
});

describe('wrapLine', () => {
  it('wraps greedily at word boundaries within the width', () => {
    // 10 px font → 5 px per character; 50 px holds 10 characters.
    expect(wrapLine('aaa bbb ccc ddd', 50, width)).toEqual(['aaa bbb', 'ccc ddd']);
  });

  it('breaks a word longer than the line', () => {
    expect(wrapLine('abcdefghijklmnop', 25, width)).toEqual(['abcde', 'fghij', 'klmno', 'p']);
  });

  it('wraps Han text between characters', () => {
    expect(wrapLine('你好世界你好', 15, width)).toEqual(['你好世', '界你好']);
  });

  it('never returns empty lines', () => {
    expect(wrapLine('   ', 50, width)).toEqual([]);
  });
});

describe('layoutTextBlock', () => {
  const style = { fontSize: 10, lineHeightRatio: 1.4, paragraphGapRatio: 0.5, maxWidth: 60 };

  it('positions lines on a 1.4 line-height grid with a gap between paragraphs', () => {
    const block = layoutTextBlock('one\n\ntwo', style, measure);
    expect(block.lineHeight).toBe(14);
    expect(block.lines.map((l) => l.y)).toEqual([0, 21]);
    expect(block.height).toBe(35);
  });

  it('hangs a bullet’s continuation lines under its text', () => {
    const block = layoutTextBlock('→ aaaa bbbb cccc', style, measure);
    expect(block.lines[0]).toMatchObject({ bullet: true, indent: 10 });
    expect(block.lines[1]).toMatchObject({ bullet: false, indent: 10 });
  });
});

describe('visibleLength', () => {
  it('counts code points with whitespace collapsed', () => {
    expect(visibleLength('  a  b\n\nc ')).toBe(5);
    expect(visibleLength('مرحبا')).toBe(5);
  });
});
