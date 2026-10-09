import type { Metadata } from 'next';

// 26.2 — one shape for every public page's metadata: a canonical URL and og:url (made absolute by
// the root layout's metadataBase), a page-specific description, and both link-preview cards with
// the image. A page that sets `openGraph` or `twitter` replaces the root's file-based image, so the
// image is named here explicitly (src/app/opengraph-image.tsx and src/app/twitter-image.tsx).

export const SITE_NAME = 'PostMind Studio';
export const OG_IMAGE_SIZE = { width: 1200, height: 630 } as const;

export interface PublicPageMetadataInput {
  /** The page's path, e.g. "/sign-in" (the canonical and og:url). */
  path: string;
  /** The page title; shown as "<title> · PostMind Studio" unless `absoluteTitle`. */
  title: string;
  description: string;
  /** The request locale (en-GB → og:locale en_GB). */
  locale: string;
  /** Alt text for the link-preview image. */
  imageAlt: string;
  absoluteTitle?: boolean;
  /** Utility pages (forgot password) keep a canonical but stay out of search results. */
  index?: boolean;
}

export function publicPageMetadata({
  path,
  title,
  description,
  locale,
  imageAlt,
  absoluteTitle = false,
  index = true,
}: PublicPageMetadataInput): Metadata {
  const fullTitle = absoluteTitle ? title : `${title} · ${SITE_NAME}`;
  return {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates: { canonical: path },
    robots: index ? { index: true, follow: true } : { index: false, follow: true },
    openGraph: {
      type: 'website',
      url: path,
      siteName: SITE_NAME,
      locale: locale.replace('-', '_'),
      title: fullTitle,
      description,
      images: [{ url: '/opengraph-image', ...OG_IMAGE_SIZE, alt: imageAlt }],
    },
    twitter: {
      card: 'summary_large_image',
      title: fullTitle,
      description,
      images: [{ url: '/twitter-image', ...OG_IMAGE_SIZE, alt: imageAlt }],
    },
  };
}

/** Signed-in and one-time-link pages: never in search results. */
export const NOINDEX: Metadata['robots'] = { index: false, follow: false };
