import type { MetadataRoute } from 'next';
import { lastModified, publicPaths, siteOrigin } from '@/lib/seo/site';

// Rendered per request: APP_URL is only set at runtime (the image is built without it), so a
// build-time render would bake in the localhost fallback.
export const dynamic = 'force-dynamic';

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  return publicPaths().map((path) => ({
    url: path === '/' ? origin : `${origin}${path}`,
    lastModified: lastModified(path),
    changeFrequency: path.startsWith('/legal/') ? 'yearly' : 'monthly',
    priority: path === '/' ? 1 : path === '/pricing' ? 0.8 : 0.3,
  }));
}
