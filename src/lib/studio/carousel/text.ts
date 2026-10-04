// Text handling for carousel post cards (21.6): clean-up, paragraphs, → bullets, word wrapping.
// Pure: widths come from a `MeasureText` function (font-metrics.ts on the server, a stub in tests).

/** Width in px of `text` set at `fontSize` px (bold for the display name). */
export type MeasureText = (text: string, fontSize: number, bold?: boolean) => number;

export interface TextBlockLine {
  /** The characters on this line (bullet marker not included). */
  readonly text: string;
  /** True on the first line of a bullet item (the renderer draws the → marker before it). */
  readonly bullet: boolean;
  /** Horizontal indent in px (continuation lines of a bullet hang under its text). */
  readonly indent: number;
  /** Top of the line box, px from the top of the block. */
  readonly y: number;
}

export interface TextBlock {
  readonly lines: readonly TextBlockLine[];
  readonly height: number;
  readonly fontSize: number;
  readonly lineHeight: number;
}

export interface TextStyle {
  readonly fontSize: number;
  /** Line height as a multiple of the font size (generous: 1.4). */
  readonly lineHeightRatio: number;
  /** Extra space between paragraphs as a multiple of the line height. */
  readonly paragraphGapRatio: number;
  readonly maxWidth: number;
}

export const BULLET_MARKER = '→';
const BULLET_PREFIX = /^\s*(?:→|->|➜|➔|•|·|-|\*)\s+/u;

// Emoji and their joiners/modifiers. A bundled font with colour emoji would add ~10 MB and the
// renderer's fallback would otherwise pick whatever the host has (or draw empty boxes), so emoji
// are removed from slides, consistently in preview and render (the "degrade gracefully" option of
// the 21.6 spec). Arrows such as → are not pictographic and stay.
const EMOJI =
  /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}‍︎️⃣]/gu;

export interface CleanText {
  readonly text: string;
  /** Characters dropped (emoji, or characters no bundled font can draw). */
  readonly removed: number;
}

/**
 * Normalise line endings, drop emoji and characters no font in the stack can draw (`covered`),
 * trim trailing spaces on each line and collapse runs of 3+ newlines to a paragraph break.
 */
export function cleanSlideText(text: string, covered: (codePoint: number) => boolean): CleanText {
  const normalised = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  let removed = 0;
  const withoutEmoji = normalised.replace(EMOJI, (m) => {
    removed += [...m].length;
    return '';
  });
  let kept = '';
  for (const ch of withoutEmoji) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '\n' || ch === ' ' || covered(cp)) {
      kept += ch;
    } else {
      removed += 1;
    }
  }
  const tidy = kept
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: tidy, removed };
}

export interface ParsedLine {
  readonly text: string;
  readonly bullet: boolean;
}

/** Paragraphs (blank-line separated) of lines; "→ ", "- ", "• " … starts become bullets. */
export function parseParagraphs(text: string): ParsedLine[][] {
  return text
    .split(/\n\s*\n/)
    .map((para) =>
      para
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) =>
          BULLET_PREFIX.test(line)
            ? { text: line.replace(BULLET_PREFIX, ''), bullet: true }
            : { text: line, bullet: false },
        ),
    )
    .filter((para) => para.length > 0);
}

const HAN = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/u;

/** Break a line into wrap tokens: words with their trailing space; Han/Kana characters singly. */
function tokens(line: string): string[] {
  const out: string[] = [];
  for (const word of line.split(/(?<= )/u)) {
    if (HAN.test(word)) {
      for (const ch of word) out.push(ch);
    } else if (word.length > 0) {
      out.push(word);
    }
  }
  return out;
}

/** Split a token wider than `maxWidth` into pieces that fit (long URLs, hashtags). */
function breakLongToken(token: string, maxWidth: number, width: (s: string) => number): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const ch of token) {
    if (current.length > 0 && width(current + ch) > maxWidth) {
      pieces.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current.length > 0) pieces.push(current);
  return pieces;
}

/** Greedy word wrap of one logical line into lines no wider than `maxWidth`. */
export function wrapLine(line: string, maxWidth: number, width: (s: string) => number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const token of tokens(line)) {
    const candidate = current + token;
    if (width(candidate.trimEnd()) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current.trim().length > 0) lines.push(current.trimEnd());
    if (width(token.trimEnd()) <= maxWidth) {
      current = token;
    } else {
      const pieces = breakLongToken(token.trimEnd(), maxWidth, width);
      lines.push(...pieces.slice(0, -1));
      current = pieces[pieces.length - 1] ?? '';
    }
  }
  if (current.trim().length > 0) lines.push(current.trimEnd());
  return lines;
}

/** Lay a text out into positioned lines at `style`. */
export function layoutTextBlock(text: string, style: TextStyle, measure: MeasureText): TextBlock {
  const lineHeight = Math.round(style.fontSize * style.lineHeightRatio);
  const paragraphGap = Math.round(lineHeight * style.paragraphGapRatio);
  const width = (s: string): number => measure(s, style.fontSize);
  const bulletIndent = Math.ceil(measure(`${BULLET_MARKER} `, style.fontSize));
  const lines: TextBlockLine[] = [];
  let y = 0;
  parseParagraphs(text).forEach((para, p) => {
    if (p > 0) y += paragraphGap;
    for (const line of para) {
      const indent = line.bullet ? bulletIndent : 0;
      wrapLine(line.text, style.maxWidth - indent, width).forEach((wrapped, i) => {
        lines.push({ text: wrapped, bullet: line.bullet && i === 0, indent, y });
        y += lineHeight;
      });
    }
  });
  return { lines, height: y, fontSize: style.fontSize, lineHeight };
}

/** Count of characters a reader sees (for the 150/200-character slide rules). */
export function visibleLength(text: string): number {
  return [...text.replace(/\s+/g, ' ').trim()].length;
}
