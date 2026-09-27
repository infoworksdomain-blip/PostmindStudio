import type { StockImageSource } from '../../src/lib/studio/images/stock';
import { fakePng } from '../helpers/png';

// GP-09 fixture: a one-page bakery website (robots allows us) plus a stock-photo source whose
// images are served from the same fake fetch.

export function goldenWebsite() {
  const site = 'https://golden-bakery.example';
  const page = `<!doctype html><html><head><title>Golden Bakery</title></head><body><main>
    <h1>Golden Bakery</h1><p>${'Slow-fermented sourdough baked at dawn in Leeds. '.repeat(10)}</p>
    <img src="/img/hero.png" alt="Golden sourdough loaf"></main></body></html>`;
  const pageFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === 'images.stock.example')
      return new Response(fakePng(2000, 1333, 300 + Number(url.pathname.replace(/\D/g, ''))), {
        headers: { 'content-type': 'image/png' },
      });
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\n');
    if (url.pathname === '/img/hero.png')
      return new Response(fakePng(1600, 900, 201), { headers: { 'content-type': 'image/png' } });
    if (url.pathname === '/')
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const stock: StockImageSource = {
    provider: 'pexels',
    async search({ query }) {
      return [1, 2].map((i) => ({
        provider: 'pexels' as const,
        providerImageId: `${query.length}${i}`,
        imageUrl: `https://images.stock.example/${query.length}${i}.png`,
        width: 2000,
        height: 1333,
        alt: `${query} photo ${i}`,
        pageUrl: `https://www.pexels.com/photo/${query.length}${i}/`,
        attribution: { name: 'A Photographer', url: null },
        storable: true,
      }));
    },
    async downloadUrl(hit) {
      return hit.imageUrl;
    },
  };
  return { site, pageFetch, stock };
}
