import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGAL_DOCS } from '@/lib/legal/documents';
import { legalTextState, unfilledMarkers } from '@/lib/legal/markers';

// 20.31: the demo's public legal pages render the repository's real texts (content/legal/en-GB),
// exactly what the live site renders, with no draft banner and no [[…]] fill-in markers.

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('demo legal pages', () => {
  it.each(LEGAL_DOCS)('%s is the finished text: no placeholder, no fill-in markers', (doc) => {
    const text = read(`content/legal/en-GB/${doc}.md`);
    expect(unfilledMarkers(text)).toEqual([]);
    expect(legalTextState(text)).toBe('ready');
  });

  it('the demo bundles every one of the six documents from content/legal/en-GB', () => {
    const source = read('demo/public-pages.tsx');
    for (const doc of LEGAL_DOCS) {
      expect(source, doc).toContain(`../content/legal/en-GB/${doc}.md`);
    }
    // The banner and "draft" notice follow the text itself, so a finished text shows neither.
    expect(source).toContain('placeholder={state !== ');
    expect(source).toContain("draft={state === 'fill_in'}");
  });

  it('the built demo (when present) carries the real company details and no fill-in marker', () => {
    const built = join(root, 'demo/dist/postmind-studio-demo.html');
    if (!existsSync(built)) return; // built by `node scripts/demo/build.mjs`, not in CI's unit job
    const html = readFileSync(built, 'utf8');
    expect(html).toContain('Postmind AI Ltd');
    expect(html).not.toMatch(/\[\[[A-Z][A-Z ]{3,}\]\]/);
  });
});
