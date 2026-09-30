// Phase 20.8 — the URL of a file under public/marketing/ (photos and product screenshots). The app
// serves them from /marketing/…; the single-file demo build swaps this module for
// demo/shims/marketing-media-src.ts, which inlines the same files as data: URLs (the demo page
// cannot load files from its host).

export function marketingSrc(path: string): string {
  return `/marketing/${path}`;
}
