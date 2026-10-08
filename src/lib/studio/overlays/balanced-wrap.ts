// 25 polish (production QA 2026-10-08): a wall-of-text block wrapped greedily by the renderer
// left ragged blocks — a full line, then "opener," or "fire" alone on the last line. The block is
// now broken into lines here, before it reaches the timeline (overlays/shotstack.ts overlayClip,
// which both Shotstack and the local renderer draw from): the same number of lines the greedy
// wrap would use at `maxChars`, with the words spread so the lines are as even as possible
// (least sum of squared line lengths, a min-raggedness DP), and a single word left alone on the
// last line only when nothing else fits. Each line the owner wrote is balanced on its own; their
// line breaks are kept. Text in a script without spaces between words (Han/Kana/Hangul) is left
// to the renderer, which breaks it per character.

const NO_SPACE_SCRIPT = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/u;
/** Cost added to a layout whose last line is one word (when the line has more than one word). */
const ORPHAN_PENALTY = 1_000_000;

function charLength(s: string): number {
  return [...s].length;
}

/** Words of a line; a word longer than `maxChars` is cut into `maxChars` pieces (as greedy does). */
function wordsOf(line: string, maxChars: number): string[] {
  const out: string[] = [];
  for (const word of line.trim().split(/\s+/u)) {
    if (!word) continue;
    const chars = [...word];
    for (let i = 0; i < chars.length; i += maxChars)
      out.push(chars.slice(i, i + maxChars).join(''));
  }
  return out;
}

/** Greedy wrap of words into lines of at most `maxChars` characters (the renderer's own rule). */
export function greedyLines(words: readonly string[], maxChars: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || charLength(candidate) <= maxChars) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * The words split into exactly `count` lines of at most `maxChars` characters with the least sum
 * of squared line lengths (the evenest split), avoiding a one-word last line when possible.
 * Null when no such split exists.
 */
function evenestSplit(words: readonly string[], count: number, maxChars: number): string[] | null {
  const n = words.length;
  const lengths = words.map(charLength);
  const span = (from: number, to: number): number => {
    let len = to - from - 1;
    for (let i = from; i < to; i += 1) len += lengths[i] ?? 0;
    return len;
  };
  // cost[k][i]: least cost of the first i words on k lines; from[k][i]: where line k starts.
  const cost: number[][] = Array.from({ length: count + 1 }, () =>
    new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY),
  );
  const from: number[][] = Array.from({ length: count + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  cost[0]![0] = 0;
  for (let k = 1; k <= count; k += 1) {
    for (let i = k; i <= n; i += 1) {
      for (let j = i - 1; j >= k - 1; j -= 1) {
        const len = span(j, i);
        if (len > maxChars) break;
        const prev = cost[k - 1]![j]!;
        if (!Number.isFinite(prev)) continue;
        const orphan = k === count && i === n && i - j === 1 && n > 1 ? ORPHAN_PENALTY : 0;
        const total = prev + len * len + orphan;
        if (total < cost[k]![i]!) {
          cost[k]![i] = total;
          from[k]![i] = j;
        }
      }
    }
  }
  if (!Number.isFinite(cost[count]![n]!)) return null;
  const lines: string[] = [];
  for (let k = count, i = n; k > 0; k -= 1) {
    const j = from[k]![i]!;
    lines.unshift(words.slice(j, i).join(' '));
    i = j;
  }
  return lines;
}

/** One logical line broken into balanced lines of at most `maxChars` characters. */
export function balanceLine(line: string, maxChars: number): string[] {
  const words = wordsOf(line, Math.max(1, Math.floor(maxChars)));
  if (words.length === 0) return [];
  const limit = Math.max(1, Math.floor(maxChars));
  const greedy = greedyLines(words, limit);
  if (greedy.length <= 1) return greedy;
  return evenestSplit(words, greedy.length, limit) ?? greedy;
}

/**
 * The text with every line balanced to at most `maxChars` characters (see the file comment).
 * Blank lines are kept; text in a script without spaces is returned unchanged.
 */
export function balanceWrap(text: string, maxChars: number): string {
  if (!text.trim() || NO_SPACE_SCRIPT.test(text)) return text;
  return text
    .split(/\r?\n/u)
    .map((line) => (line.trim() ? balanceLine(line, maxChars).join('\n') : ''))
    .join('\n');
}
