import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inline, parseGuide, renderBlocks, renderGoLiveHtml, REPO_BLOB } from './go-live-html';

// Phase 19.2 — docs-site/go-live.html is generated from runbooks/go-live.md.

const ROOT = join(__dirname, '..', '..', '..');
const MARKDOWN = readFileSync(join(ROOT, 'runbooks', 'go-live.md'), 'utf8');

describe('go-live page', () => {
  it('the committed page matches the guide (run: npx tsx scripts/setup/render-go-live.ts)', () => {
    const committed = readFileSync(join(ROOT, 'docs-site', 'go-live.html'), 'utf8');
    expect(committed).toBe(renderGoLiveHtml(MARKDOWN));
  });

  it('is self-contained: no external script, only Google Fonts stylesheets', () => {
    const html = renderGoLiveHtml(MARKDOWN);
    expect(html).not.toMatch(/<script[^>]+src=/);
    const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]!);
    expect(sheets.every((h) => h.startsWith('https://fonts.googleapis.com/'))).toBe(true);
    expect(html).toContain('<title>Studio Go-Live Checklist</title>');
    expect(html).toContain('prefers-color-scheme:dark');
  });

  it('has a collapsible section per ## and a tick box per step', () => {
    const model = parseGuide(MARKDOWN);
    const html = renderGoLiveHtml(MARKDOWN);
    expect((html.match(/<details class="section"/g) ?? []).length).toBe(model.sections.length);
    const steps = model.sections
      .filter((s) => !/^(Troubleshooting|Sources)$/.test(s.title))
      .reduce((n, s) => n + Math.max(1, s.steps.length), 0);
    expect((html.match(/data-step="/g) ?? []).length).toBe(steps);
    const ids = [...html.matchAll(/data-step="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries every env var name the guide mentions', () => {
    const html = renderGoLiveHtml(MARKDOWN);
    for (const key of new Set(MARKDOWN.match(/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/g) ?? []))
      expect(html, key).toContain(key);
  });

  it('contains no secret-looking value', () => {
    expect(MARKDOWN).not.toMatch(/\b(sk|rk)_(live|test)_[A-Za-z0-9]{8,}/);
    expect(MARKDOWN).not.toMatch(/\bwhsec_[A-Za-z0-9]{8,}/);
    expect(MARKDOWN).not.toMatch(/\bre_[A-Za-z0-9]{10,}/);
    expect(MARKDOWN).not.toMatch(/\bAKIA[A-Z0-9]{16}\b/);
  });
});

describe('markdown converter', () => {
  it('escapes HTML and renders code, bold and links (runbook links go to GitHub)', () => {
    expect(inline('a <b> & **c** `x<y>` [r](r2-setup.md) [e](https://e.test/a?b=1&c=2)')).toBe(
      `a &lt;b&gt; &amp; <strong>c</strong> <code>x&lt;y&gt;</code> <a href="${REPO_BLOB}r2-setup.md" target="_blank" rel="noopener">r</a> <a href="https://e.test/a?b=1&amp;c=2" target="_blank" rel="noopener">e</a>`,
    );
  });

  it('nests lists, keeps code blocks and continuations inside their item', () => {
    const html = renderBlocks([
      '- **Run:**',
      '',
      '```bash',
      'echo <hi>',
      '```',
      '',
      '  It prints hi.',
      '- Choose:',
      '  - one',
      '  - two',
      '',
      '  Nothing else.',
      'After.',
    ]);
    expect(html).toBe(
      '<ul><li><strong>Run:</strong><div class="code"><button type="button" class="copy" aria-label="Copy this command">Copy</button><pre><code data-lang="bash">echo &lt;hi&gt;</code></pre></div><p>It prints hi.</p></li><li>Choose:<p>Nothing else.</p><ul><li>one</li><li>two</li></ul></li></ul>\n<p>After.</p>',
    );
  });

  it('renders ordered lists and tables', () => {
    expect(renderBlocks(['1. a', '2. b'])).toBe('<ol><li>a</li><li>b</li></ol>');
    expect(renderBlocks(['| A | B |', '| --- | --- |', '| `x` | y |'])).toBe(
      '<div class="table-wrap"><table><thead><tr><th scope="col">A</th><th scope="col">B</th></tr></thead><tbody><tr><td><code>x</code></td><td>y</td></tr></tbody></table></div>',
    );
  });
});
