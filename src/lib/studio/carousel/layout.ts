// Slide geometry for carousel post cards (21.6). Pure: positions every element of a slide from a
// SlidePlan; svg.ts draws the shapes and render.ts places glyphs and pictures at these positions.
import {
  AVATAR_GAP,
  AVATAR_SIZE,
  CONTENT_WIDTH,
  DIVIDER_THICKNESS,
  HANDLE_FONT_SIZE,
  HEADER_HEIGHT,
  HEADER_TO_TEXT,
  IMAGE_MAX_HEIGHT,
  IMAGE_RADIUS,
  LINE_HEIGHT_RATIO,
  NAME_FONT_SIZE,
  PAIR_GAP,
  PARAGRAPH_GAP_RATIO,
  SAFE_X,
  SAFE_Y,
  SAFE_HEIGHT,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  TEXT_TO_IMAGE,
  THEMES,
  type CarouselTheme,
} from './constants';
import { BULLET_MARKER, layoutTextBlock, type MeasureText, type TextBlock } from './text';
import type { CarouselImage, CarouselProfile, SlidePart, SlidePlan } from './types';

export type Direction = 'ltr' | 'rtl';

export interface ImageBox {
  readonly width: number;
  readonly height: number;
}

/** Fit an image to the content width, keeping its aspect ratio, no taller than `maxHeight`. */
export function imageBox(image: CarouselImage, maxHeight = IMAGE_MAX_HEIGHT): ImageBox {
  const ratio = image.height / image.width;
  const fullHeight = Math.round(CONTENT_WIDTH * ratio);
  if (fullHeight <= maxHeight) return { width: CONTENT_WIDTH, height: fullHeight };
  return { width: Math.round(maxHeight / ratio), height: maxHeight };
}

export function bodyTextBlock(text: string, fontSize: number, measure: MeasureText): TextBlock {
  return layoutTextBlock(
    text,
    {
      fontSize,
      lineHeightRatio: LINE_HEIGHT_RATIO,
      paragraphGapRatio: PARAGRAPH_GAP_RATIO,
      maxWidth: CONTENT_WIDTH,
    },
    measure,
  );
}

export interface MeasuredPart {
  readonly block: TextBlock;
  readonly image: ImageBox | null;
  readonly height: number;
}

/** Height of one post card: header, text, image. */
export function measurePart(
  part: Pick<SlidePart, 'text' | 'image'>,
  fontSize: number,
  measure: MeasureText,
): MeasuredPart {
  const block = bodyTextBlock(part.text, fontSize, measure);
  const image = part.image ? imageBox(part.image) : null;
  const textHeight = block.lines.length > 0 ? HEADER_TO_TEXT + block.height : 0;
  const imageHeight = image ? TEXT_TO_IMAGE + image.height : 0;
  return { block, image, height: HEADER_HEIGHT + textHeight + imageHeight };
}

/** Total content height of a slide holding `parts` (two parts get a divider between them). */
export function slideContentHeight(measured: readonly MeasuredPart[]): number {
  const cards = measured.reduce((sum, m) => sum + m.height, 0);
  return cards + (measured.length - 1) * (PAIR_GAP * 2 + DIVIDER_THICKNESS);
}

export function fitsSafeArea(measured: readonly MeasuredPart[]): boolean {
  return slideContentHeight(measured) <= SAFE_HEIGHT;
}

export type SlideElement =
  | {
      readonly type: 'avatar';
      readonly x: number;
      readonly y: number;
      readonly size: number;
      readonly initial: string;
    }
  | {
      readonly type: 'text';
      readonly role: 'name' | 'handle' | 'body' | 'bullet';
      /** Left edge (ltr) or right edge (rtl) of the text. */
      readonly x: number;
      /** Top of the line box. */
      readonly y: number;
      readonly lineHeight: number;
      readonly text: string;
      readonly fontSize: number;
      readonly bold: boolean;
      readonly colour: string;
      readonly align: 'left' | 'right';
      /** Estimated ink width (px), for the overflow check. */
      readonly width: number;
    }
  | {
      readonly type: 'image';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly radius: number;
      readonly imageId: string;
    }
  | {
      readonly type: 'divider';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly thickness: number;
      readonly colour: string;
    };

export interface SlideLayout {
  readonly width: number;
  readonly height: number;
  readonly theme: CarouselTheme;
  readonly direction: Direction;
  readonly background: string;
  readonly elements: readonly SlideElement[];
  readonly contentTop: number;
  readonly contentHeight: number;
}

export interface LayoutContext {
  readonly theme: CarouselTheme;
  readonly direction: Direction;
  readonly profile: CarouselProfile;
  readonly measure: MeasureText;
}

/** First letter of the display name, for the avatar when there is no logo. */
export function initialOf(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toLocaleUpperCase() : '';
}

const HEADER_TEXT_WIDTH = CONTENT_WIDTH - AVATAR_SIZE - AVATAR_GAP;

/** Shorten `text` with an ellipsis until it is no wider than `maxWidth`. */
export function fitToWidth(text: string, maxWidth: number, width: (s: string) => number): string {
  if (width(text) <= maxWidth) return text;
  const chars = [...text];
  while (chars.length > 1 && width(`${chars.join('').trimEnd()}…`) > maxWidth) chars.pop();
  return `${chars.join('').trimEnd()}…`;
}

function headerElements(top: number, ctx: LayoutContext): SlideElement[] {
  const colours = THEMES[ctx.theme];
  const rtl = ctx.direction === 'rtl';
  const avatarX = rtl ? SLIDE_WIDTH - SAFE_X - AVATAR_SIZE : SAFE_X;
  const textX = rtl ? avatarX - AVATAR_GAP : SAFE_X + AVATAR_SIZE + AVATAR_GAP;
  const align = rtl ? 'right' : 'left';
  const out: SlideElement[] = [
    {
      type: 'avatar',
      x: avatarX,
      y: top,
      size: AVATAR_SIZE,
      initial: initialOf(ctx.profile.displayName),
    },
  ];
  const nameLine = Math.round(NAME_FONT_SIZE * 1.25);
  const handleLine = Math.round(HANDLE_FONT_SIZE * 1.25);
  const hasHandle = ctx.profile.handle.trim().length > 0;
  const stack = hasHandle ? nameLine + handleLine : nameLine;
  const nameY = top + Math.round((AVATAR_SIZE - stack) / 2);
  const name = fitToWidth(ctx.profile.displayName, HEADER_TEXT_WIDTH, (s) =>
    ctx.measure(s, NAME_FONT_SIZE, true),
  );
  out.push({
    type: 'text',
    role: 'name',
    x: textX,
    y: nameY,
    lineHeight: nameLine,
    text: name,
    fontSize: NAME_FONT_SIZE,
    bold: true,
    colour: colours.text,
    align,
    width: ctx.measure(name, NAME_FONT_SIZE, true),
  });
  if (hasHandle) {
    const handle = fitToWidth(`@${ctx.profile.handle.trim()}`, HEADER_TEXT_WIDTH, (s) =>
      ctx.measure(s, HANDLE_FONT_SIZE),
    );
    out.push({
      type: 'text',
      role: 'handle',
      x: textX,
      y: nameY + nameLine,
      lineHeight: handleLine,
      text: handle,
      fontSize: HANDLE_FONT_SIZE,
      bold: false,
      colour: colours.handle,
      align,
      width: ctx.measure(handle, HANDLE_FONT_SIZE),
    });
  }
  return out;
}

function cardElements(
  part: SlidePart,
  measured: MeasuredPart,
  top: number,
  ctx: LayoutContext,
): SlideElement[] {
  const colours = THEMES[ctx.theme];
  const rtl = ctx.direction === 'rtl';
  const out = headerElements(top, ctx);
  let y = top + HEADER_HEIGHT;
  const { block } = measured;
  if (block.lines.length > 0) {
    y += HEADER_TO_TEXT;
    const markerWidth = ctx.measure(BULLET_MARKER, block.fontSize);
    for (const line of block.lines) {
      const lineX = rtl ? SLIDE_WIDTH - SAFE_X - line.indent : SAFE_X + line.indent;
      if (line.bullet) {
        out.push({
          type: 'text',
          role: 'bullet',
          x: rtl ? SLIDE_WIDTH - SAFE_X : SAFE_X,
          y: y + line.y,
          lineHeight: block.lineHeight,
          // An Arabic bullet points the reading way.
          text: rtl ? '←' : BULLET_MARKER,
          fontSize: block.fontSize,
          bold: false,
          colour: colours.text,
          align: rtl ? 'right' : 'left',
          width: markerWidth,
        });
      }
      out.push({
        type: 'text',
        role: 'body',
        x: lineX,
        y: y + line.y,
        lineHeight: block.lineHeight,
        text: line.text,
        fontSize: block.fontSize,
        bold: false,
        colour: colours.text,
        align: rtl ? 'right' : 'left',
        width: ctx.measure(line.text, block.fontSize),
      });
    }
    y += block.height;
  }
  if (part.image && measured.image) {
    y += TEXT_TO_IMAGE;
    const x = rtl ? SLIDE_WIDTH - SAFE_X - measured.image.width : SAFE_X;
    out.push({
      type: 'image',
      x,
      y,
      width: measured.image.width,
      height: measured.image.height,
      radius: IMAGE_RADIUS,
      imageId: part.image.imageId,
    });
  }
  return out;
}

/** Every element of a slide, content centred vertically (never above the safe area). */
export function buildSlideLayout(plan: SlidePlan, ctx: LayoutContext): SlideLayout {
  const colours = THEMES[ctx.theme];
  const measured = plan.parts.map((part) => measurePart(part, plan.fontSize, ctx.measure));
  const contentHeight = slideContentHeight(measured);
  const contentTop = Math.max(SAFE_Y, Math.round((SLIDE_HEIGHT - contentHeight) / 2));
  const elements: SlideElement[] = [];
  let y = contentTop;
  plan.parts.forEach((part, i) => {
    const m = measured[i];
    if (!m) return;
    if (i > 0) {
      y += PAIR_GAP;
      elements.push({
        type: 'divider',
        x: SAFE_X,
        y,
        width: CONTENT_WIDTH,
        thickness: DIVIDER_THICKNESS,
        colour: colours.divider,
      });
      y += DIVIDER_THICKNESS + PAIR_GAP;
    }
    elements.push(...cardElements(part, m, y, ctx));
    y += m.height;
  });
  return {
    width: SLIDE_WIDTH,
    height: SLIDE_HEIGHT,
    theme: ctx.theme,
    direction: ctx.direction,
    background: colours.background,
    elements,
    contentTop,
    contentHeight,
  };
}
