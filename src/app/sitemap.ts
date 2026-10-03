import type { MetadataRoute } from 'next';
import { publicPaths, siteOrigin } from '@/lib/seo/site';

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  return publicPaths().map((path) => ({
    url: path === '/' ? origin : `${origin}${path}`,
    changeFrequency: path.startsWith('/legal/') ? 'yearly' : 'monthly',
    priority: path === '/' ? 1 : path === '/pricing' ? 0.8 : 0.3,
  }));
}
