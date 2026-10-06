import { describe, expect, it } from 'vitest';
import { NotImplementedError } from '../../../errors';
import { aiLabelClip } from '../../pipeline/ai-label';
import { HEADLINE_DIM } from '../../slideshow/edl';
import { cssOf, ffmpegColour, hexOf, parseColour, unescapeHtml } from './edit-json';
import { htmlCard, parseCss, parseHtmlBody, richTextCard } from './text-card';

const SLIDESHOW_CSS =
  "p { font-family: 'Inter', sans-serif; color: #ffffff; font-size: 67px; font-weight: 700; text-align: center; margin: 0; background: rgba(0,0,0,0.45); padding: 0.3em; } small { display: block; font-size: 0.55em; font-weight: 400; margin-top: 0.4em; }";

describe('parseColour', () => {
  it.each([
    ['#fff', { r: 255, g: 255, b: 255, a: 1 }],
    ['#3A4150', { r: 58, g: 65, b: 80, a: 1 }],
    ['rgba(0,0,0,0.45)', { r: 0, g: 0, b: 0, a: 0.45 }],
    ['rgb(10, 20, 30)', { r: 10, g: 20, b: 30, a: 1 }],
    ['transparent', { r: 0, g: 0, b: 0, a: 0 }],
    ['#FFFFFF80', { r: 255, g: 255, b: 255, a: 128 / 255 }],
  ])('%s', (value, expected) => {
    expect(parseColour(value)).toEqual(expected);
  });

  it('reads Shotstack 8-digit html backgrounds alpha first', () => {
    expect(parseColour(HEADLINE_DIM, true)).toEqual({ r: 0, g: 0, b: 0, a: 128 / 255 });
  });

  it('rejects other colour syntax', () => {
    expect(parseColour('red')).toBeNull();
  });

  it('formats colours for sharp, SVG and ffmpeg', () => {
    const c = { r: 58, g: 65, b: 80, a: 0.5 };
    expect(hexOf(c)).toBe('#3a4150');
    expect(cssOf(c)).toBe('rgba(58,65,80,0.5)');
    expect(ffmpegColour(c)).toBe('0x3A4150');
  });

  it('undoes the composer’s HTML escaping', () => {
    expect(unescapeHtml('Fish &amp; chips &lt;3 &quot;now&quot; it&#39;s')).toBe(
      'Fish & chips <3 "now" it\'s',
    );
  });
});

describe('htmlCard', () => {
  it('reads a slideshow quote: main line, small byline, shade and padding', () => {
    const card = htmlCard({
      type: 'html',
      html: '<p>“Best bread in Leeds”<small>— Sam</small></p>',
      css: SLIDESHOW_CSS,
      width: 918,
      height: 960,
      position: 'center',
    });
    expect(card).toMatchObject({
      width: 918,
      height: 960,
      fill: null,
      fontFamily: 'Inter',
      direction: 'ltr',
      align: 'center',
      anchor: 'center',
      collapseWhitespace: true,
      blockBackground: {
        colour: { r: 0, g: 0, b: 0, a: 0.45 },
        paddingPx: 20,
        radiusPx: 0,
        fullWidth: true,
      },
    });
    expect(card.paragraphs).toEqual([
      {
        text: '“Best bread in Leeds”',
        sizePx: 67,
        bold: true,
        colour: { r: 255, g: 255, b: 255, a: 1 },
        marginTopPx: 0,
      },
      {
        text: '— Sam',
        sizePx: 37,
        bold: false,
        colour: { r: 255, g: 255, b: 255, a: 1 },
        marginTopPx: 15,
      },
    ]);
  });

  it('reads a headline dim (no text, alpha-first fill)', () => {
    const card = htmlCard({
      type: 'html',
      html: '<p></p>',
      css: 'p { margin: 0; }',
      width: 1080,
      height: 1920,
      background: HEADLINE_DIM,
    });
    expect(card.paragraphs).toEqual([]);
    expect(card.fill).toEqual({ r: 0, g: 0, b: 0, a: 128 / 255 });
    expect(card.blockBackground).toBeNull();
  });

  it('reads the AI label (pipeline/ai-label.ts) in Arabic as right-to-left', () => {
    const clip = aiLabelClip({
      lang: 'ar',
      startSec: 0,
      lengthSec: 5,
      frame: { width: 1080, height: 1920 },
      fontFamily: 'Noto Sans Arabic',
      rtl: true,
    });
    const card = htmlCard(clip.asset as Record<string, unknown>);
    expect(card.direction).toBe('rtl');
    expect(card.fontFamily).toBe('Noto Sans Arabic');
    expect(card.paragraphs[0]?.sizePx).toBe(35);
    expect(card.paragraphs[0]?.bold).toBe(true);
  });

  it.each([
    ['other tags', { html: '<p>a <b>b</b></p>' }],
    ['two paragraphs', { html: '<p>a</p><p>b</p>' }],
    ['an unknown css property', { css: 'p { font-size: 20px; text-shadow: 1px 1px #000; }' }],
    ['a size in em', { css: 'p { font-size: 2em; }' }],
    ['justified text', { css: 'p { font-size: 20px; text-align: justify; }' }],
    ['a named colour', { css: 'p { font-size: 20px; color: red; }' }],
  ])('refuses %s', (_, patch) => {
    expect(() =>
      htmlCard({
        type: 'html',
        html: '<p>Hi</p>',
        css: 'p { font-size: 20px; }',
        width: 100,
        height: 100,
        ...patch,
      }),
    ).toThrow(NotImplementedError);
  });

  it('needs a box size', () => {
    expect(() => htmlCard({ type: 'html', html: '<p>Hi</p>' })).toThrow(NotImplementedError);
  });
});

describe('parseHtmlBody / parseCss', () => {
  it('splits small lines out of the body', () => {
    expect(parseHtmlBody('<p>Sourdough<small>✓ Organic</small><small>✓ Local</small></p>')).toEqual(
      {
        rtl: false,
        main: 'Sourdough',
        small: ['✓ Organic', '✓ Local'],
      },
    );
  });

  it('reads selector blocks', () => {
    const css = parseCss(SLIDESHOW_CSS);
    expect(css.get('p')?.get('font-size')).toBe('67px');
    expect(css.get('small')?.get('margin-top')).toBe('0.4em');
  });
});

describe('richTextCard', () => {
  it('reads stroke, shadow, background, alignment and line height', () => {
    const card = richTextCard(
      {
        type: 'rich-text',
        text: '‏مرحبا',
        font: {
          family: 'Noto Sans Arabic',
          size: 80,
          weight: 700,
          color: '#ffcc00',
          opacity: 0.5,
          style: 'italic',
        },
        align: { horizontal: 'left', vertical: 'top' },
        style: { lineHeight: 1.4, letterSpacing: 2 },
        stroke: { width: 3, color: '#000000', opacity: 1 },
        shadow: { offsetX: 0, offsetY: 2, blur: 6, color: '#000000', opacity: 0.5 },
        background: { color: '#222222', opacity: 0.8, borderRadius: 12, wrap: true, padding: 8 },
      },
      { width: 972, height: 400 },
    );
    expect(card).toMatchObject({
      width: 972,
      height: 400,
      direction: 'rtl',
      align: 'left',
      anchor: 'topLeft',
      lineHeight: 1.4,
      collapseWhitespace: false,
      stroke: { widthPx: 3 },
      shadow: { offsetX: 0, offsetY: 2, blurPx: 6, colour: { r: 0, g: 0, b: 0, a: 0.5 } },
      blockBackground: {
        paddingPx: 8,
        radiusPx: 12,
        fullWidth: false,
        colour: { r: 0x22, g: 0x22, b: 0x22, a: 0.8 },
      },
    });
    expect(card.paragraphs[0]).toMatchObject({
      text: 'مرحبا',
      sizePx: 80,
      bold: true,
      colour: { r: 255, g: 204, b: 0, a: 0.5 },
    });
    expect(card.approximations).toEqual(['letter spacing not applied', 'italic drawn upright']);
  });

  it('centres by default and needs a font size', () => {
    expect(richTextCard({ text: 'Hi', font: { size: 40 } }, { width: 10, height: 10 }).anchor).toBe(
      'center',
    );
    expect(
      richTextCard(
        { text: 'Hi', font: { size: 40 }, align: { horizontal: 'right', vertical: 'bottom' } },
        { width: 10, height: 10 },
      ).anchor,
    ).toBe('bottomRight');
    expect(() => richTextCard({ text: 'Hi', font: {} }, { width: 10, height: 10 })).toThrow(
      NotImplementedError,
    );
  });
});
