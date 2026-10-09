// 26.2 — where the brand artwork is served from (public/brand/). The single-file demo build swaps
// this module for demo/shims/brand-src.ts, which inlines the same files as data: URLs.

export const BRAND_SRC = {
  logoLight: { webp: '/brand/logo-light.webp', png: '/brand/logo-light.png' },
  logoDark: { webp: '/brand/logo-dark.webp', png: '/brand/logo-dark.png' },
  icon: '/brand/icon-64.png',
} as const;
