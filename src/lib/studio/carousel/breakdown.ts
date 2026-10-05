// Slide breakdown for carousel post cards (21.6): which posts go on which slide. The rules are the
// "instagram-thread-carousel" skill's (operator-supplied, SKILL.md reviewed 2026-10-04):
//   - the hook (post 1) gets its own slide; so does the call to action (the last post);
//   - a post with an image gets its own slide with only 1–3 short lines; more text is split into an
//     image slide with a short label and then text-only detail slides;
//   - a post over ~200 characters gets its own slide;
//   - consecutive short posts (under ~150 characters, no image) share a slide, two per slide;
//   - text that would overflow is split across slides rather than shrunk below the readable minimum.
import {
  BODY_FONT_SIZES,
  IMAGE_SLIDE_MAX_LINES,
  LONG_POST_CHARS,
  MIN_BODY_FONT_SIZE,
  SHORT_POST_CHARS,
} from './constants';
import { bodyTextBlock, fitsSafeArea, measurePart } from './layout';
import { parseParagraphs, visibleLength, type MeasureText } from './text';
import type { CarouselPost, SlidePart, SlidePlan } from './types';

type PartInput = Pick<SlidePart, 'text' | 'image'>;

/** Largest body size at which `parts` fit the safe area (image cards: at most 3 lines). */
export function fitFontSize(parts: readonly PartInput[], measure: MeasureText): number | undefined {
  return BODY_FONT_SIZES.find((size) => {
    const measured = parts.map((p) => measurePart(p, size, measure));
    const imageLinesOk = parts.every(
      (p, i) => !p.image || (measured[i]?.block.lines.length ?? 0) <= IMAGE_SLIDE_MAX_LINES,
    );
    return imageLinesOk && fitsSafeArea(measured);
  });
}

function fitsAlone(text: string, measure: MeasureText): boolean {
  return fitFontSize([{ text, image: null }], measure) !== undefined;
}

const SENTENCE_END = /(?<=[.!?…。！？؟])\s+/u;

function paragraphText(lines: readonly { text: string; bullet: boolean }[]): string {
  return lines.map((l) => (l.bullet ? `→ ${l.text}` : l.text)).join('\n');
}

/** Pieces of `text` no bigger than a paragraph, sentence or wrapped line, in reading order. */
function units(text: string, measure: MeasureText): string[] {
  const out: string[] = [];
  for (const para of parseParagraphs(text)) {
    const whole = paragraphText(para);
    if (fitsAlone(whole, measure)) {
      out.push(whole);
      continue;
    }
    for (const line of para) {
      const prefix = line.bullet ? '→ ' : '';
      for (const sentence of line.text.split(SENTENCE_END)) {
        const piece = `${prefix}${sentence}`;
        if (fitsAlone(piece, measure)) {
          out.push(piece);
        } else {
          const block = bodyTextBlock(piece, MIN_BODY_FONT_SIZE, measure);
          out.push(...block.lines.map((l) => l.text));
        }
      }
    }
  }
  return out;
}

/** Split text into chunks that each fit a text-only card (joins units greedily). */
export function splitTextToFit(text: string, measure: MeasureText): string[] {
  if (text.trim().length === 0) return [];
  if (fitsAlone(text, measure)) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const unit of units(text, measure)) {
    const candidate = current ? `${current}\n\n${unit}` : unit;
    if (current && !fitsAlone(candidate, measure)) {
      chunks.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * For an image post whose text is too long for an image slide: a short label (the first sentence,
 * or the first lines) for the image slide and the rest for detail slides.
 */
export function splitImageLabel(
  post: PartInput,
  measure: MeasureText,
): { label: string; rest: string } {
  if (fitFontSize([post], measure) !== undefined) return { label: post.text, rest: '' };
  const trimmed = post.text.trim();
  const [firstSentence = ''] = trimmed.split(SENTENCE_END);
  const firstLine = firstSentence.split('\n')[0] ?? '';
  if (firstLine && fitFontSize([{ text: firstLine, image: post.image }], measure) !== undefined) {
    return {
      label: firstLine,
      rest: trimmed.slice(trimmed.indexOf(firstLine) + firstLine.length).trim(),
    };
  }
  // Even the first sentence is too long: take as many wrapped lines as an image slide allows.
  const lines = bodyTextBlock(trimmed, MIN_BODY_FONT_SIZE, measure).lines.map((l) => l.text);
  for (let n = IMAGE_SLIDE_MAX_LINES; n > 0; n -= 1) {
    const label = lines.slice(0, n).join(' ');
    if (fitFontSize([{ text: label, image: post.image }], measure) !== undefined) {
      return { label, rest: lines.slice(n).join(' ') };
    }
  }
  return { label: '', rest: trimmed };
}

interface DraftSlide {
  readonly kind: 'single' | 'pair';
  readonly parts: readonly SlidePart[];
}

function textSlides(
  post: CarouselPost,
  text: string,
  firstPart: number,
  measure: MeasureText,
): DraftSlide[] {
  return splitTextToFit(text, measure).map((chunk, i) => ({
    kind: 'single',
    parts: [{ postId: post.id, text: chunk, image: null, partIndex: firstPart + i }],
  }));
}

function ownSlides(post: CarouselPost, measure: MeasureText): DraftSlide[] {
  if (post.image) {
    const { label, rest } = splitImageLabel(post, measure);
    const imageSlide: DraftSlide = {
      kind: 'single',
      parts: [{ postId: post.id, text: label, image: post.image, partIndex: 0 }],
    };
    return [imageSlide, ...textSlides(post, rest, 1, measure)];
  }
  const slides = textSlides(post, post.text, 0, measure);
  return slides.length > 0
    ? slides
    : [{ kind: 'single', parts: [{ postId: post.id, text: '', image: null, partIndex: 0 }] }];
}

export function isShortPost(post: CarouselPost): boolean {
  return !post.image && visibleLength(post.text) < SHORT_POST_CHARS;
}

export function isLongPost(post: CarouselPost): boolean {
  return visibleLength(post.text) > LONG_POST_CHARS;
}

/** The slide breakdown of a thread. */
export function planSlides(posts: readonly CarouselPost[], measure: MeasureText): SlidePlan[] {
  const drafts: DraftSlide[] = [];
  const last = posts.length - 1;
  const pairable = (i: number): boolean => {
    const post = posts[i];
    return post !== undefined && i !== 0 && !(i === last && last > 0) && isShortPost(post);
  };
  for (let i = 0; i < posts.length; i += 1) {
    const post = posts[i];
    if (!post) continue;
    const next = posts[i + 1];
    if (pairable(i) && next && pairable(i + 1)) {
      const parts: SlidePart[] = [
        { postId: post.id, text: post.text, image: null, partIndex: 0 },
        { postId: next.id, text: next.text, image: null, partIndex: 0 },
      ];
      if (fitFontSize(parts, measure) !== undefined) {
        drafts.push({ kind: 'pair', parts });
        i += 1;
        continue;
      }
    }
    drafts.push(...ownSlides(post, measure));
  }
  return drafts.map((draft, index) => ({
    index,
    kind: draft.kind,
    parts: draft.parts,
    fontSize: fitFontSize(draft.parts, measure) ?? MIN_BODY_FONT_SIZE,
  }));
}
