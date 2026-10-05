// A thread the owner pasted (21.6) → posts. Threads are written in many shapes; in order:
//   1. posts separated by a line of three or more dashes (---);
//   2. numbered posts: a line starting "1/", "2/7", "1." or "1)" begins a new post;
//   3. posts separated by two or more blank lines;
//   4. otherwise every paragraph (single blank line) is a post.
import { MAX_POST_CHARS } from './constants';

const DIVIDER = /^\s*-{3,}\s*$/m;
const NUMBERED = /^\s*(\d{1,2})\s*(?:\/\s*\d{0,2}|[.)])\s+/;

function tidy(posts: string[], max: number): string[] {
  return posts
    .map((p) => p.replace(/\r\n?/g, '\n').trim())
    .filter((p) => p.length > 0)
    .slice(0, max)
    .map((p) => [...p].slice(0, MAX_POST_CHARS).join(''));
}

function byNumbers(text: string): string[] | null {
  const lines = text.split('\n');
  const starts = lines.flatMap((line, i) => (NUMBERED.test(line) ? [i] : []));
  if (starts.length < 2) return null;
  const numbers = starts.map((i) => Number(NUMBERED.exec(lines[i] ?? '')?.[1]));
  // Must count up from 1 so ordinary numbered lists inside a post are not split.
  if (!numbers.every((n, k) => n === k + 1)) return null;
  const preamble = lines.slice(0, starts[0]).join('\n');
  const posts = starts.map((start, k) => {
    const end = starts[k + 1] ?? lines.length;
    const body = lines.slice(start, end);
    body[0] = (body[0] ?? '').replace(NUMBERED, '');
    return body.join('\n');
  });
  return preamble.trim() ? [preamble, ...posts] : posts;
}

/** Split pasted text into at most `max` posts. */
export function parsePastedThread(text: string, max: number): string[] {
  const normalised = text.replace(/\r\n?/g, '\n').trim();
  if (!normalised) return [];
  if (DIVIDER.test(normalised)) return tidy(normalised.split(/^\s*-{3,}\s*$/m), max);
  const numbered = byNumbers(normalised);
  if (numbered) return tidy(numbered, max);
  if (/\n\s*\n\s*\n/.test(normalised)) return tidy(normalised.split(/\n\s*\n\s*\n+/), max);
  return tidy(normalised.split(/\n\s*\n/), max);
}
