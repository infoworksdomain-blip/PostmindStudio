# Marketing media (BACKLOG 20.8, 25.5)

Every file in `public/marketing/` is listed below with where it came from.
`test/unit/marketing-media.test.ts` fails when a file here is missing from this list, when a file the
pages use (`src/lib/marketing/media.ts`) is missing, has a different pixel size or is over its size
budget, or when the demo shim (`demo/shims/marketing-media-src.ts`) does not inline an image (the
demo shows Studio posters only, never the videos).

Next.js serves `public/` from the site root, so these are at `/marketing/…`. The single-file demo
build inlines the images as `data:` URLs, and its sample thumbnails and videos
(`demo/media.ts`) are drawn from the photos. Since 25.5 the landing page itself shows only real
PostMind Studio output (`studio/`) and product screens; the photos stay for the demo.

## Photos (`photos/`)

Downloaded on **2026-09-30** from Unsplash's official site, through each photo's own download link
(`https://unsplash.com/photos/<id>/download?force=true`, which serves the file from
`images.unsplash.com`), at 1,600 px on the long edge. Before download, each photo page was checked in
a browser and showed **"Free to use under the Unsplash License"** (none is an Unsplash+ photo).

Licence: the [Unsplash License](https://unsplash.com/license): free to use for commercial and
non-commercial purposes, no permission needed, attribution not required (we credit the
photographers here anyway). It does not allow selling unaltered copies or compiling photos into a
competing image service; we do neither.

Selection rules (operator, 2026-09-30): no recognisable faces that could read as an endorsement, no
logos, trademarks or brand names. Where a photo had people or a branded object near the edge, it
was cropped out (noted below). Each file was then resized to at most 900 px on the long edge and
encoded as WebP (quality 66) with `sharp`.

| File | Unsplash photo | Photographer | Crop before resize | Bytes |
| --- | --- | --- | --- | --- |
| `photos/sourdough-loaf.webp` | [3BTqX4NJqXg](https://unsplash.com/photos/3BTqX4NJqXg) — a freshly baked sourdough loaf with a leaf design | Kate Tepla ([@kate_tepla](https://unsplash.com/@kate_tepla)) | none | 27,274 |
| `photos/sourdough-hands.webp` | [smHpLKXZJA8](https://unsplash.com/photos/smHpLKXZJA8) — hands holding a freshly baked loaf of sourdough | Diego Arenas de Rodrigo | none (hands only) | 64,564 |
| `photos/sourdough-board.webp` | [6S3U_ZuiXBs](https://unsplash.com/photos/6S3U_ZuiXBs) — a rustic loaf of sourdough on a wooden board | Ryan Fleischer | none | 24,532 |
| `photos/market-stall.webp` | [b3DfrOL_Dic](https://unsplash.com/photos/b3DfrOL_Dic) — outdoor market stall with fresh bread and pastries | Annie Spratt | x 560–1600 of 1600×1200: removes the shopper in the foreground; the people left in the background are small and out of focus | 68,368 |
| `photos/dough-kneading.webp` | [zqg6ctfkYuo](https://unsplash.com/photos/zqg6ctfkYuo) — a close up of a person kneading dough | DDP | none (hands only) | 40,602 |
| `photos/croissants.webp` | [fwwCY6FVuS4](https://unsplash.com/photos/fwwCY6FVuS4) — four croissants on a decorative plate | Bayu Syaits | none | 53,770 |
| `photos/coffee.webp` | [bI8coqfybKw](https://unsplash.com/photos/bI8coqfybKw) — a white cup of coffee with latte art | Yasin Onus | none | 12,148 |
| `photos/cake.webp` | [Py0PU5aOob4](https://unsplash.com/photos/Py0PU5aOob4) — cake slices on turquoise patterned plates | Shuvro Mojumder | none | 40,830 |
| `photos/dough-balls.webp` | [lQfKoeq029A](https://unsplash.com/photos/lQfKoeq029A) — baker shaping dough balls on a counter | Martin Baron | none (hands only, motion-blurred) | 42,008 |
| `photos/breakfast.webp` | [dQ9lqaL_1Dw](https://unsplash.com/photos/dQ9lqaL_1Dw) — a breakfast spread with coffee, croissant and avocado toast | Diego Marín | none | 30,774 |

## PostMind Studio output (`studio/`)

Every file here was **made with PostMind Studio on 2026-10-07 (showcase businesses are fictional)**:
generated on production by Studio's own pipeline from one-line briefs — the two AI video clips by
Studio's video generation (Seedance), the slideshows and walls of text by Studio's own renderer
(23.5). The six businesses (Northside Bakery, Atelier Wren, Pulse Studio, Coastline Stays,
Greenleaf Florist, Harbour Coffee) are fictional; nothing here is a customer's work. Owned by the
operator.

Posters are the frame at 4.5 s (AI video: the operator's export), encoded by
`node scripts/marketing/encode-studio-media.mjs <export-folder>` (sharp: WebP quality 60 at 720 px,
64 at 360 px, JPEG quality 70 mozjpeg at 540 px); the MP4s are copied as exported. The landing page
plays them muted, only on screens 768 px and wider, without reduced motion or Save-Data, and only
while on screen; phones get the posters.

| File | What it is | Bytes |
| --- | --- | --- |
| `studio/seedance-bread-720.webp` | AI video (Seedance) from the brief “slow push-in on a golden sourdough loaf…”, 6 s, 9:16: poster, 720×1280 WebP | 27,076 |
| `studio/seedance-bread-360.webp` | AI video (Seedance) from the brief “slow push-in on a golden sourdough loaf…”, 6 s, 9:16: poster, 360×640 WebP | 11,632 |
| `studio/seedance-bread.jpg` | AI video (Seedance) from the brief “slow push-in on a golden sourdough loaf…”, 6 s, 9:16: poster fallback, 540×960 JPEG | 28,707 |
| `studio/seedance-bread.mp4` | AI video (Seedance) from the brief “slow push-in on a golden sourdough loaf…”, 6 s, 9:16: muted clip as generated, 720×1280 H.264 MP4 | 805,405 |
| `studio/seedance-market-720.webp` | AI video (Seedance) from the brief “a woman walking through a sunlit food market, smiling at a stallholder”, 6 s, 9:16: poster, 720×1280 WebP | 39,478 |
| `studio/seedance-market-360.webp` | AI video (Seedance) from the brief “a woman walking through a sunlit food market, smiling at a stallholder”, 6 s, 9:16: poster, 360×640 WebP | 16,508 |
| `studio/seedance-market.jpg` | AI video (Seedance) from the brief “a woman walking through a sunlit food market, smiling at a stallholder”, 6 s, 9:16: poster fallback, 540×960 JPEG | 39,104 |
| `studio/seedance-market.mp4` | AI video (Seedance) from the brief “a woman walking through a sunlit food market, smiling at a stallholder”, 6 s, 9:16: muted clip as generated, 720×1280 H.264 MP4 | 1,557,898 |
| `studio/northside-bakery-slideshow-720.webp` | Slideshow for Northside Bakery (sourdough bakery): poster, 720×1280 WebP | 42,834 |
| `studio/northside-bakery-slideshow-360.webp` | Slideshow for Northside Bakery (sourdough bakery): poster, 360×640 WebP | 15,024 |
| `studio/northside-bakery-slideshow.jpg` | Slideshow for Northside Bakery (sourdough bakery): poster fallback, 540×960 JPEG | 38,961 |
| `studio/northside-bakery-slideshow.mp4` | Slideshow for Northside Bakery (sourdough bakery): muted loop (first 6 s of the 12.5 s render), 540×960 H.264 MP4 | 339,228 |
| `studio/atelier-wren-slideshow-720.webp` | Slideshow for Atelier Wren (linen boutique): poster, 720×1280 WebP | 69,172 |
| `studio/atelier-wren-slideshow-360.webp` | Slideshow for Atelier Wren (linen boutique): poster, 360×640 WebP | 16,384 |
| `studio/atelier-wren-slideshow.jpg` | Slideshow for Atelier Wren (linen boutique): poster fallback, 540×960 JPEG | 46,839 |
| `studio/atelier-wren-slideshow.mp4` | Slideshow for Atelier Wren (linen boutique): muted loop (first 6 s of the 12.5 s render), 540×960 H.264 MP4 | 257,234 |
| `studio/pulse-studio-slideshow-720.webp` | Slideshow for Pulse Studio (fitness studio): poster, 720×1280 WebP | 31,760 |
| `studio/pulse-studio-slideshow-360.webp` | Slideshow for Pulse Studio (fitness studio): poster, 360×640 WebP | 13,190 |
| `studio/pulse-studio-slideshow.jpg` | Slideshow for Pulse Studio (fitness studio): poster fallback, 540×960 JPEG | 33,949 |
| `studio/pulse-studio-slideshow.mp4` | Slideshow for Pulse Studio (fitness studio): muted loop (first 6 s of the 12.5 s render), 540×960 H.264 MP4 | 179,322 |
| `studio/coastline-stays-slideshow-720.webp` | Slideshow for Coastline Stays (seaside cottages): poster, 720×1280 WebP | 100,482 |
| `studio/coastline-stays-slideshow-360.webp` | Slideshow for Coastline Stays (seaside cottages): poster, 360×640 WebP | 40,338 |
| `studio/coastline-stays-slideshow.jpg` | Slideshow for Coastline Stays (seaside cottages): poster fallback, 540×960 JPEG | 82,352 |
| `studio/coastline-stays-slideshow.mp4` | Slideshow for Coastline Stays (seaside cottages): muted loop (first 6 s of the 12.5 s render), 540×960 H.264 MP4 | 359,591 |
| `studio/greenleaf-florist-slideshow-720.webp` | Slideshow for Greenleaf Florist: poster, 720×1280 WebP | 21,774 |
| `studio/greenleaf-florist-slideshow-360.webp` | Slideshow for Greenleaf Florist: poster, 360×640 WebP | 10,174 |
| `studio/greenleaf-florist-slideshow.jpg` | Slideshow for Greenleaf Florist: poster fallback, 540×960 JPEG | 27,365 |
| `studio/greenleaf-florist-slideshow.mp4` | Slideshow for Greenleaf Florist: muted loop (first 6 s of the 12.5 s render), 540×960 H.264 MP4 | 196,099 |
| `studio/harbour-coffee-slideshow-720.webp` | Slideshow for Harbour Coffee (coffee shop): poster, 720×1280 WebP | 27,600 |
| `studio/harbour-coffee-slideshow-360.webp` | Slideshow for Harbour Coffee (coffee shop): poster, 360×640 WebP | 12,524 |
| `studio/harbour-coffee-slideshow.jpg` | Slideshow for Harbour Coffee (coffee shop): poster fallback, 540×960 JPEG | 30,766 |
| `studio/harbour-coffee-slideshow.mp4` | Slideshow for Harbour Coffee (coffee shop): muted loop (first 6 s of the 12.5 s render), 540×960 H.264 MP4 | 184,223 |
| `studio/pulse-studio-wall-of-text-720.webp` | Wall-of-text post for Pulse Studio (fitness studio): poster, 720×1280 WebP | 34,002 |
| `studio/pulse-studio-wall-of-text-360.webp` | Wall-of-text post for Pulse Studio (fitness studio): poster, 360×640 WebP | 16,004 |
| `studio/pulse-studio-wall-of-text.jpg` | Wall-of-text post for Pulse Studio (fitness studio): poster fallback, 540×960 JPEG | 34,921 |
| `studio/pulse-studio-wall-of-text.mp4` | Wall-of-text post for Pulse Studio (fitness studio): muted loop (first 6 s of the 12.5 s render), 540×960 H.264 MP4 | 237,494 |
| `studio/coastline-stays-wall-of-text-720.webp` | Wall-of-text post for Coastline Stays (seaside cottages): poster, 720×1280 WebP | 39,066 |
| `studio/coastline-stays-wall-of-text-360.webp` | Wall-of-text post for Coastline Stays (seaside cottages): poster, 360×640 WebP | 19,220 |
| `studio/coastline-stays-wall-of-text.jpg` | Wall-of-text post for Coastline Stays (seaside cottages): poster fallback, 540×960 JPEG | 40,557 |
| `studio/coastline-stays-wall-of-text.mp4` | Wall-of-text post for Coastline Stays (seaside cottages): muted loop (first 6 s of the 12.5 s render), 540×960 H.264 MP4 | 262,421 |

## Product screens (`screens/`)

Original screenshots of PostMind Studio's own screens, captured from the demo build (sample data for
Leeds Sourdough, a fictional bakery) by `scripts/marketing/capture-screens.mjs`, recaptured on
2026-10-07 in the 25.4 app shell, at 1200×750 in the light and dark themes, WebP quality 72. No third-party material except the photos
above, which appear as the demo's sample thumbnails (generate). Owned by the operator. 25.5 dropped
the Brief and Review captures: the landing page no longer uses the brief screen, and the review
capture showed a "Content safety" check that Studio no longer runs (Hive was removed in 20.21).

| File | Screen | Bytes |
| --- | --- | --- |
| `screens/script-light.webp` | Project → Script tab | 35,330 |
| `screens/script-dark.webp` | Project → Script tab (dark) | 35,438 |
| `screens/generate-light.webp` | Business & images → Image library | 80,326 |
| `screens/generate-dark.webp` | Business & images → Image library (dark) | 78,734 |
| `screens/calendar-light.webp` | Calendar | 44,746 |
| `screens/calendar-dark.webp` | Calendar (dark) | 43,718 |
| `screens/analytics-light.webp` | Analytics | 29,292 |
| `screens/analytics-dark.webp` | Analytics (dark) | 28,312 |

To refresh the screens after a UI change: `node scripts/demo/build.mjs`, serve it with
`node scripts/demo/serve.mjs 3021 demo/dist/postmind-studio-demo.html`, run
`node scripts/marketing/capture-screens.mjs`, then update the byte counts here.
