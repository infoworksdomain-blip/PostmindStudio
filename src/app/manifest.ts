import type { MetadataRoute } from 'next';

// 26.2 — the web app manifest (/manifest.webmanifest): installable name, the Daylight canvas
// (--canvas, oklch(0.985 0.002 250), as sRGB hex) for the splash and browser chrome, and the mark
// at the sizes browsers ask for (public/brand/icon*.png, built by scripts/brand/build-brand-assets.mjs).

export const CANVAS_HEX = '#f7f8fa';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'PostMind Studio',
    short_name: 'Studio',
    description:
      'Create, plan and publish short videos and posts for your business from one brief.',
    start_url: '/home',
    scope: '/',
    display: 'standalone',
    background_color: CANVAS_HEX,
    theme_color: CANVAS_HEX,
    icons: [
      { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/brand/icon.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
