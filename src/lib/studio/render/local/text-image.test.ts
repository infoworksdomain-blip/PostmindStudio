import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { wallOverlay } from '../../../../../test/helpers/local-render-fixtures';
import { overlayClip } from '../../overlays/shotstack';
import {
  bundledFace,
  layoutLines,
  placeIn,
  renderTextCard,
  scriptOfText,
  stackFor,
} from './text-image';
import { htmlCard, richTextCard, type TextCard } from './text-card';

// Real sharp + Pango with the bundled fonts (the carousel pipeline), so these also prove the
// renderer's text is deterministic and drawn where the edit says.

const FRAME = { width: 1080, height: 1920 };

async function pixels(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    data,
    info,
    at: (x: number, y: number) =>
      Array.from(data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)),
  };
}

/** Bounding box of pixels with alpha above 0. */
function inkBox(data: Buffer, width: number, height: number) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) > 0) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

function wallCard(): TextCard {
  const clip = overlayClip(wallOverlay(), { frame: FRAME, offsetSec: 0 });
  return richTextCard(clip.asset as Record<string, unknown>, {
    width: clip.width as number,
    height: clip.height as number,
  });
}

describe('renderTextCard', () => {
  it('draws the wall-of-text block: white fill with a black outline, centred, transparent around', async () => {
    const card = wallCard();
    const out = await renderTextCard(card);
    expect([out.width, out.height]).toEqual([card.width, card.height]);
    const { data, info } = await pixels(out.png);
    const box = inkBox(data, info.width, info.height);
    // Centred horizontally and vertically (within a few px of rounding).
    expect(Math.abs(box.minX - (info.width - 1 - box.maxX))).toBeLessThan(info.width * 0.05);
    expect(Math.abs(box.minY - (info.height - 1 - box.maxY))).toBeLessThan(20);
    // Both the white fill and the black stroke are present.
    let white = 0;
    let black = 0;
    for (let i = 0; i < data.length; i += 4) {
      if ((data[i + 3] ?? 0) < 250) continue;
      if ((data[i] ?? 0) > 240 && (data[i + 1] ?? 0) > 240) white += 1;
      if ((data[i] ?? 255) < 15 && (data[i + 1] ?? 255) < 15) black += 1;
    }
    expect(white).toBeGreaterThan(1000);
    expect(black).toBeGreaterThan(1000);
    expect(out.notes).toEqual([]);
  });

  it('is deterministic', async () => {
    const card = wallCard();
    const [a, b] = await Promise.all([renderTextCard(card), renderTextCard(card)]);
    expect(Buffer.compare(a.png, b.png)).toBe(0);
  });

  it('fills an html card’s box and puts its shaded caption at the bottom', async () => {
    const card = htmlCard({
      type: 'html',
      html: '<p>Plan tomorrow tonight</p>',
      css: "p { font-family: 'Arial', sans-serif; color: #ffffff; font-size: 67px; font-weight: 700; text-align: center; margin: 0; background: rgba(0,0,0,0.45); padding: 0.3em; }",
      width: 972,
      height: 384,
      position: 'bottom',
      background: '#3A4150',
    });
    const out = await renderTextCard(card);
    const { at } = await pixels(out.png);
    expect(at(5, 5)).toEqual([0x3a, 0x41, 0x50, 255]); // the box fill
    const shade = at(5, 383);
    expect(shade[0]).toBeLessThan(0x3a); // the 45 % black band over the fill, full width
    expect(out.notes).toEqual(['font Arial drawn in Inter']);
  });

  it('returns a transparent box for an empty dim layer with its fill', async () => {
    const card = htmlCard({
      type: 'html',
      html: '<p></p>',
      css: 'p { margin: 0; }',
      width: 20,
      height: 10,
      background: '#80000000',
    });
    const { at } = await pixels((await renderTextCard(card)).png);
    expect(at(10, 5)).toEqual([0, 0, 0, 128]);
  });

  it('masks text taller than its box', async () => {
    const card = { ...wallCard(), height: 60 };
    const out = await renderTextCard(card);
    expect(out.height).toBe(60);
    expect(out.notes).toContain('text taller than its box was masked');
  });
});

describe('layout helpers', () => {
  it('wraps paragraphs to the box with the fonts’ own widths', () => {
    const { stack } = stackFor('Montserrat', 'latin');
    const card = wallCard();
    const { lines, height } = layoutLines(
      { ...card, paragraphs: [{ ...card.paragraphs[0]!, text: 'word '.repeat(40) }] },
      stack,
      600,
    );
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines)
      expect(stack.measure(line.text, line.sizePx, line.bold)).toBeLessThanOrEqual(600);
    expect(height).toBe(lines.length * Math.round(card.paragraphs[0]!.sizePx * card.lineHeight));
  });

  it('places items at the nine positions', () => {
    const area = { width: 100, height: 50 };
    const item = { width: 20, height: 10 };
    expect(placeIn('center', item, area)).toEqual({ x: 40, y: 20 });
    expect(placeIn('topLeft', item, area)).toEqual({ x: 0, y: 0 });
    expect(placeIn('bottomRight', item, area)).toEqual({ x: 80, y: 40 });
    expect(placeIn('top', item, area)).toEqual({ x: 40, y: 0 });
    expect(placeIn('left', item, area)).toEqual({ x: 0, y: 20 });
  });

  it('knows the bundled fonts and writing systems', () => {
    expect(bundledFace('Montserrat')).toEqual({ family: 'Montserrat', file: 'Montserrat.ttf' });
    expect(bundledFace('Bebas Neue')).toEqual({ family: 'Bebas Neue', file: 'BebasNeue.ttf' });
    expect(bundledFace('Arial')).toBeNull();
    expect(scriptOfText('مرحبا')).toBe('arabic');
    expect(scriptOfText('नमस्ते')).toBe('devanagari');
    expect(scriptOfText('你好')).toBe('han');
    expect(scriptOfText('Hello')).toBe('latin');
  });
});
