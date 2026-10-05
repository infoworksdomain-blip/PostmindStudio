// "Waterfall" lists (21.6, from the instagram-thread-carousel skill): list lines read best from the
// shortest to the longest. Applied to a post's → bullet lines in the editor, and to AI threads.
import { parseParagraphs, visibleLength } from './text';

/** Shortest-to-longest, stable for equal lengths. */
export function orderWaterfall(lines: readonly string[]): string[] {
  return lines
    .map((line, index) => ({ line, index, length: visibleLength(line) }))
    .sort((a, b) => a.length - b.length || a.index - b.index)
    .map((entry) => entry.line);
}

/**
 * Reorder every run of consecutive bullet lines in `text` shortest-first; other lines stay put.
 * Returns the text unchanged when it has no list of two or more bullets.
 */
export function waterfallBullets(text: string): string {
  const paragraphs = parseParagraphs(text).map((para) => {
    const out: string[] = [];
    let run: string[] = [];
    const flush = (): void => {
      out.push(...orderWaterfall(run).map((line) => `→ ${line}`));
      run = [];
    };
    for (const line of para) {
      if (line.bullet) {
        run.push(line.text);
      } else {
        flush();
        out.push(line.text);
      }
    }
    flush();
    return out.join('\n');
  });
  return paragraphs.join('\n\n');
}
