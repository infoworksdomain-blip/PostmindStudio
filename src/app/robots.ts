import type { MetadataRoute } from 'next';
import { disallowedPaths, siteOrigin } from '@/lib/seo/site';

// Rendered per request so the sitemap and host lines use the runtime APP_URL (see sitemap.ts).
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  const origin = siteOrigin();
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: disallowedPaths() }],
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
