import type { MetadataRoute } from 'next';
import { disallowedPaths, siteOrigin } from '@/lib/seo/site';

export default function robots(): MetadataRoute.Robots {
  const origin = siteOrigin();
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: disallowedPaths() }],
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
