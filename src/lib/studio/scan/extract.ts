import { load, type CheerioAPI } from 'cheerio';

// BACKLOG 6.2 / Addendum A6.2 step 2 — extract discoverable structure from one HTML page:
// meta description, og:* and twitter:* meta, h1–h3, body text (article/main first, 5000 chars),
// every <img> (src, srcset best candidate, alt, figcaption), JSON-LD blocks and same-site links.

export const MAX_BODY_TEXT = 5_000;
const MAX_IMAGES_PER_PAGE = 200;
const MAX_LINKS_PER_PAGE = 500;
const MAX_JSONLD_BLOCKS = 20;

export interface ExtractedImage {
  url: string;
  alt: string | null;
  caption: string | null;
  /** Declared width/height attributes, when present (used to drop icons before download). */
  declaredWidth: number | null;
  declaredHeight: number | null;
  pageUrl: string;
}

export interface ExtractedPage {
  url: string;
  title: string | null;
  metaDescription: string | null;
  openGraph: Record<string, string>;
  twitter: Record<string, string>;
  headings: string[];
  bodyText: string;
  images: ExtractedImage[];
  jsonLd: unknown[];
  links: string[];
  /** Heuristic from A6.2 step 1: little text but lots of script → probably a JS-rendered SPA. */
  looksJsRendered: boolean;
}

const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

function absolute(raw: string | undefined, base: URL): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value || value.startsWith('data:') || value.startsWith('javascript:')) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** Largest candidate in a srcset ("a.jpg 480w, b.jpg 1080w" → b.jpg). */
export function bestSrcsetCandidate(srcset: string | undefined): string | undefined {
  if (!srcset) return undefined;
  let best: { url: string; score: number } | undefined;
  for (const part of srcset.split(',')) {
    const [url, descriptor] = part.trim().split(/\s+/, 2);
    if (!url) continue;
    const score = descriptor ? Number.parseFloat(descriptor) || 0 : 1;
    if (!best || score > best.score) best = { url, score };
  }
  return best?.url;
}

function metaMap($: CheerioAPI, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  $(`meta[property^="${prefix}:"], meta[name^="${prefix}:"]`).each((_, el) => {
    const key = ($(el).attr('property') ?? $(el).attr('name') ?? '').slice(prefix.length + 1);
    const content = $(el).attr('content');
    if (key && content && !(key in out)) out[key] = clean(content).slice(0, 1_000);
  });
  return out;
}

function parseJsonLd($: CheerioAPI): unknown[] {
  const blocks: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    if (blocks.length >= MAX_JSONLD_BLOCKS) return;
    try {
      const parsed = JSON.parse($(el).text()) as unknown;
      if (Array.isArray(parsed)) blocks.push(...parsed.slice(0, MAX_JSONLD_BLOCKS));
      else blocks.push(parsed);
    } catch {
      // invalid JSON-LD on the site is common; skip the block
    }
  });
  return blocks.slice(0, MAX_JSONLD_BLOCKS);
}

function dimension(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function extractPage(html: string, pageUrl: string): ExtractedPage {
  const base = new URL(pageUrl);
  const $ = load(html);
  const scriptCount = $('script').length;

  const images: ExtractedImage[] = [];
  const seenImages = new Set<string>();
  $('img').each((_, el) => {
    if (images.length >= MAX_IMAGES_PER_PAGE) return;
    const img = $(el);
    const url = absolute(
      bestSrcsetCandidate(img.attr('srcset')) ??
        img.attr('src') ??
        img.attr('data-src') ??
        undefined,
      base,
    );
    if (!url || seenImages.has(url)) return;
    seenImages.add(url);
    const caption = clean(img.closest('figure').find('figcaption').first().text());
    images.push({
      url,
      alt: clean(img.attr('alt') ?? '') || null,
      caption: caption || null,
      declaredWidth: dimension(img.attr('width')),
      declaredHeight: dimension(img.attr('height')),
      pageUrl,
    });
  });

  const links: string[] = [];
  const seenLinks = new Set<string>();
  $('a[href]').each((_, el) => {
    if (links.length >= MAX_LINKS_PER_PAGE) return;
    const url = absolute($(el).attr('href'), base);
    if (!url || new URL(url).host !== base.host || seenLinks.has(url)) return;
    seenLinks.add(url);
    links.push(url);
  });

  const headings = $('h1, h2, h3')
    .map((_, el) => clean($(el).text()))
    .get()
    .filter(Boolean)
    .slice(0, 100);

  const jsonLd = parseJsonLd($);
  $('script, style, noscript, template, svg').remove();
  const prioritised = $('main, article')
    .map((_, el) => clean($(el).text()))
    .get()
    .join(' ');
  const whole = clean($('body').text());
  const bodyText = (prioritised.length >= 200 ? prioritised : whole).slice(0, MAX_BODY_TEXT);

  return {
    url: pageUrl,
    title: clean($('title').first().text()) || null,
    metaDescription: clean($('meta[name="description"]').attr('content') ?? '') || null,
    openGraph: metaMap($, 'og'),
    twitter: metaMap($, 'twitter'),
    headings,
    bodyText,
    images,
    jsonLd,
    links,
    looksJsRendered: whole.length < 500 && scriptCount >= 5,
  };
}

/** URLs listed in a sitemap.xml (<loc> entries), same host only. */
export function extractSitemapUrls(xml: string, siteUrl: string, limit = 500): string[] {
  const host = new URL(siteUrl).host;
  const $ = load(xml, { xml: true });
  const out: string[] = [];
  $('loc').each((_, el) => {
    if (out.length >= limit) return;
    const url = absolute($(el).text(), new URL(siteUrl));
    if (url && new URL(url).host === host) out.push(url);
  });
  return out;
}
