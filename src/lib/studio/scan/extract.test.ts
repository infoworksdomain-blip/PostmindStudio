import { describe, expect, it } from 'vitest';
import { bestSrcsetCandidate, extractPage, extractSitemapUrls, MAX_BODY_TEXT } from './extract';

describe('extractPage — meta / OG / twitter', () => {
  it('extracts title, meta description, og:* and twitter:* tags', () => {
    const html = `
      <html><head>
        <title>My Site</title>
        <meta name="description" content="A great site">
        <meta property="og:title" content="OG Title">
        <meta property="og:description" content="OG Desc">
        <meta name="twitter:card" content="summary_large_image">
      </head><body></body></html>`;
    const page = extractPage(html, 'https://example.com/');
    expect(page.title).toBe('My Site');
    expect(page.metaDescription).toBe('A great site');
    expect(page.openGraph).toEqual({ title: 'OG Title', description: 'OG Desc' });
    expect(page.twitter).toEqual({ card: 'summary_large_image' });
  });

  it('returns null for missing title and meta description', () => {
    const page = extractPage('<html><body>hi</body></html>', 'https://example.com/');
    expect(page.title).toBeNull();
    expect(page.metaDescription).toBeNull();
  });
});

describe('extractPage — headings', () => {
  it('collects h1–h3 text, trimmed and de-whitespaced, up to 100', () => {
    const html = `<html><body>
      <h1>  Big   Title </h1>
      <h2>Sub</h2>
      <h3>Sub sub</h3>
      <h4>Not collected</h4>
    </body></html>`;
    const page = extractPage(html, 'https://example.com/');
    expect(page.headings).toEqual(['Big Title', 'Sub', 'Sub sub']);
  });

  it('filters out empty headings', () => {
    const html = '<html><body><h1></h1><h2>  </h2><h3>Real</h3></body></html>';
    const page = extractPage(html, 'https://example.com/');
    expect(page.headings).toEqual(['Real']);
  });
});

describe('extractPage — body text prioritisation and cap', () => {
  it('prefers main/article text over the whole body when it is substantial', () => {
    const mainText = 'M'.repeat(250);
    const html = `<html><body><nav>ignore nav</nav><main>${mainText}</main><footer>ignore footer</footer></body></html>`;
    const page = extractPage(html, 'https://example.com/');
    expect(page.bodyText).toBe(mainText);
    expect(page.bodyText).not.toContain('ignore nav');
  });

  it('falls back to the whole body when main/article text is too thin (<200 chars)', () => {
    const html =
      '<html><body><main>short</main><p>rest of the body text goes here</p></body></html>';
    const page = extractPage(html, 'https://example.com/');
    expect(page.bodyText).toContain('rest of the body text goes here');
  });

  it('caps body text at MAX_BODY_TEXT characters', () => {
    const longText = 'x'.repeat(MAX_BODY_TEXT + 500);
    const html = `<html><body><main>${longText}</main></body></html>`;
    const page = extractPage(html, 'https://example.com/');
    expect(page.bodyText).toHaveLength(MAX_BODY_TEXT);
  });

  it('removes script, style, noscript, template and svg content before extracting text', () => {
    const html = `<html><body><main>${'A'.repeat(250)}<script>evil()</script><style>.x{}</style></main></body></html>`;
    const page = extractPage(html, 'https://example.com/');
    expect(page.bodyText).not.toContain('evil');
  });
});

describe('bestSrcsetCandidate', () => {
  it('returns undefined for an empty/undefined srcset', () => {
    expect(bestSrcsetCandidate(undefined)).toBeUndefined();
    expect(bestSrcsetCandidate('')).toBeUndefined();
  });

  it('picks the candidate with the highest width descriptor', () => {
    expect(bestSrcsetCandidate('a.jpg 480w, b.jpg 1080w, c.jpg 768w')).toBe('b.jpg');
  });

  it('treats a candidate with no descriptor as score 1', () => {
    expect(bestSrcsetCandidate('a.jpg, b.jpg 0.5x')).toBe('a.jpg');
  });
});

describe('extractPage — images', () => {
  it('prefers the best srcset candidate over src', () => {
    const html =
      '<html><body><img src="small.jpg" srcset="small.jpg 480w, big.jpg 1200w"></body></html>';
    const page = extractPage(html, 'https://example.com/');
    expect(page.images).toHaveLength(1);
    expect(page.images[0]?.url).toBe('https://example.com/big.jpg');
  });

  it('falls back to data-src when there is no src or srcset', () => {
    const html = '<html><body><img data-src="lazy.jpg"></body></html>';
    const page = extractPage(html, 'https://example.com/');
    expect(page.images[0]?.url).toBe('https://example.com/lazy.jpg');
  });

  it('captures a figcaption from the enclosing figure', () => {
    const html =
      '<html><body><figure><img src="a.jpg"><figcaption> A caption </figcaption></figure></body></html>';
    const page = extractPage(html, 'https://example.com/');
    expect(page.images[0]?.caption).toBe('A caption');
  });

  it('captures declared width/height attributes', () => {
    const html = '<html><body><img src="a.jpg" width="100" height="50"></body></html>';
    const page = extractPage(html, 'https://example.com/');
    expect(page.images[0]?.declaredWidth).toBe(100);
    expect(page.images[0]?.declaredHeight).toBe(50);
  });

  it('leaves declared dimensions null when absent or invalid', () => {
    const html = '<html><body><img src="a.jpg" width="notanumber"></body></html>';
    const page = extractPage(html, 'https://example.com/');
    expect(page.images[0]?.declaredWidth).toBeNull();
    expect(page.images[0]?.declaredHeight).toBeNull();
  });

  it('ignores an image URL that fails to parse as a URL', () => {
    const html = '<html><body><img src="http://[not-a-valid-host"></body></html>';
    const page = extractPage(html, 'https://example.com/');
    expect(page.images).toHaveLength(0);
  });

  it('ignores data: URIs', () => {
    const html = '<html><body><img src="data:image/png;base64,AAAA"></body></html>';
    const page = extractPage(html, 'https://example.com/');
    expect(page.images).toHaveLength(0);
  });

  it('de-duplicates identical resolved image URLs', () => {
    const html = '<html><body><img src="a.jpg"><img src="./a.jpg"><img src="b.jpg"></body></html>';
    const page = extractPage(html, 'https://example.com/');
    expect(page.images.map((i) => i.url)).toEqual([
      'https://example.com/a.jpg',
      'https://example.com/b.jpg',
    ]);
  });

  it('sets alt to null when the attribute is missing or blank', () => {
    const html = '<html><body><img src="a.jpg"><img src="b.jpg" alt="  "></body></html>';
    const page = extractPage(html, 'https://example.com/');
    expect(page.images[0]?.alt).toBeNull();
    expect(page.images[1]?.alt).toBeNull();
  });
});

describe('extractPage — JSON-LD', () => {
  it('parses a valid JSON-LD block', () => {
    const html =
      '<html><body><script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script></body></html>';
    const page = extractPage(html, 'https://example.com/');
    expect(page.jsonLd).toEqual([{ '@type': 'Organization', name: 'Acme' }]);
  });

  it('flattens a JSON-LD array into individual blocks', () => {
    const html =
      '<html><body><script type="application/ld+json">[{"a":1},{"b":2}]</script></body></html>';
    const page = extractPage(html, 'https://example.com/');
    expect(page.jsonLd).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('skips invalid JSON-LD blocks without throwing', () => {
    const html = `<html><body>
      <script type="application/ld+json">{not valid json}</script>
      <script type="application/ld+json">{"ok":true}</script>
    </body></html>`;
    const page = extractPage(html, 'https://example.com/');
    expect(page.jsonLd).toEqual([{ ok: true }]);
  });
});

describe('extractPage — links', () => {
  it('keeps only same-host links, de-duplicated', () => {
    const html = `<html><body>
      <a href="/about">About</a>
      <a href="https://example.com/about">About again</a>
      <a href="https://other.com/page">Other host</a>
      <a href="javascript:void(0)">JS link</a>
      <a href="#fragment">Fragment only</a>
    </body></html>`;
    const page = extractPage(html, 'https://example.com/home');
    expect(page.links).toEqual(['https://example.com/about', 'https://example.com/home']);
  });
});

describe('extractPage — looksJsRendered', () => {
  it('is true when body text is thin and there are many scripts', () => {
    const scripts = Array.from({ length: 6 }, (_, i) => `<script>var a${i}=1;</script>`).join('');
    const html = `<html><body>${scripts}<div id="root"></div></body></html>`;
    const page = extractPage(html, 'https://example.com/');
    expect(page.looksJsRendered).toBe(true);
  });

  it('is false when there is substantial body text', () => {
    const scripts = Array.from({ length: 6 }, (_, i) => `<script>var a${i}=1;</script>`).join('');
    const html = `<html><body>${scripts}<main>${'word '.repeat(200)}</main></body></html>`;
    const page = extractPage(html, 'https://example.com/');
    expect(page.looksJsRendered).toBe(false);
  });

  it('is false when there are few scripts, even with thin text', () => {
    const html = '<html><body><script>1</script><p>short</p></body></html>';
    const page = extractPage(html, 'https://example.com/');
    expect(page.looksJsRendered).toBe(false);
  });
});

describe('extractSitemapUrls', () => {
  it('extracts <loc> entries that are on the same host', () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://example.com/a</loc></url>
      <url><loc>https://example.com/b</loc></url>
      <url><loc>https://other.com/c</loc></url>
    </urlset>`;
    const urls = extractSitemapUrls(xml, 'https://example.com/');
    expect(urls).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('respects the limit parameter', () => {
    const xml = `<urlset>${Array.from(
      { length: 5 },
      (_, i) => `<url><loc>https://example.com/p${i}</loc></url>`,
    ).join('')}</urlset>`;
    const urls = extractSitemapUrls(xml, 'https://example.com/', 2);
    expect(urls).toHaveLength(2);
  });

  it('resolves relative <loc> entries against the site URL', () => {
    const xml = '<urlset><url><loc>/relative</loc></url></urlset>';
    const urls = extractSitemapUrls(xml, 'https://example.com/');
    expect(urls).toEqual(['https://example.com/relative']);
  });
});
