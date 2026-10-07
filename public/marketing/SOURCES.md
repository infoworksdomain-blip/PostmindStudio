# Marketing images (BACKLOG 20.8, 25.5)

Every file in `public/marketing/` is listed below with where it came from.
`test/unit/marketing-media.test.ts` fails when a file here is missing from this list, when a file the
pages use (`src/lib/marketing/media.ts`) is missing or has a different pixel size, or when the demo
shim (`demo/shims/marketing-media-src.ts`) does not inline it.

Next.js serves `public/` from the site root, so these are at `/marketing/…`. The single-file demo
build inlines the same files as `data:` URLs, and its sample thumbnails and videos
(`demo/media.ts`) are drawn from the photos. Since 2026-10-07 the landing page itself shows only
real PostMind Studio output (`studio/`) and product screens; the photos stay for the demo.

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
Studio's video generation (Seedance), the slideshows by Studio's own renderer (23.5). The
businesses (Atelier Wren, Pulse Studio, Coastline Stays, Greenleaf Florist, Harbour Coffee) are
fictional; nothing here is a customer's work. Owned by the operator.

Posters are the frame at 4.5 s, encoded with sharp (WebP quality 60 at 720 px, 64 at 360 px); the
files are byte-identical to the ones the full landing redesign (PR #138) adds. Slideshow posters
carry their own burnt-in caption at the bottom; the landing page crops that strip out and shows the
same words in its caption chip (`src/components/marketing/scene-frame.tsx`).

| File | What it is | Bytes |
| --- | --- | --- |
| `studio/seedance-bread-720.webp` | AI video (Seedance) from the brief “slow push-in on a golden sourdough loaf…”, 6 s, 9:16: poster, 720×1280 WebP (hero phone) | 27,076 |
| `studio/seedance-market-360.webp` | AI video (Seedance) from the brief “a woman walking through a sunlit food market, smiling at a stallholder”, 6 s, 9:16: poster, 360×640 WebP (hero card) | 16,508 |
| `studio/coastline-stays-slideshow-360.webp` | Slideshow for Coastline Stays (seaside cottages): poster, 360×640 WebP (hero card) | 40,338 |
| `studio/atelier-wren-slideshow-720.webp` | Slideshow for Atelier Wren (linen boutique): poster, 720×1280 WebP (contact sheet 9:16) | 69,172 |
| `studio/harbour-coffee-slideshow-720.webp` | Slideshow for Harbour Coffee (coffee shop): poster, 720×1280 WebP (contact sheet 16:9, cropped) | 27,600 |
| `studio/greenleaf-florist-slideshow-720.webp` | Slideshow for Greenleaf Florist (florist): poster, 720×1280 WebP (contact sheet 1:1, cropped) | 21,774 |
| `studio/pulse-studio-slideshow-720.webp` | Slideshow for Pulse Studio (fitness studio): poster, 720×1280 WebP (contact sheet 4:5, cropped) | 31,760 |

## Product screens (`screens/`)

Original screenshots of PostMind Studio's own screens, captured from the demo build (sample data for
Leeds Sourdough, a fictional bakery) by `scripts/marketing/capture-screens.mjs` on 2026-09-30 at
1200×750 in the light and dark themes, WebP quality 72. No third-party material except the photos
above, which appear as the demo's sample thumbnails (generate, review). Owned by the operator.

| File | Screen | Bytes |
| --- | --- | --- |
| `screens/brief-light.webp` | Create, with a brief typed in | 24,788 |
| `screens/brief-dark.webp` | Create, with a brief typed in (dark) | 25,766 |
| `screens/script-light.webp` | Project → Script tab | 29,878 |
| `screens/script-dark.webp` | Project → Script tab (dark) | 31,760 |
| `screens/generate-light.webp` | Business & images → Image library | 82,346 |
| `screens/generate-dark.webp` | Business & images → Image library (dark) | 82,380 |
| `screens/review-light.webp` | Project → Variants with quality checks | 37,696 |
| `screens/review-dark.webp` | Project → Variants with quality checks (dark) | 36,448 |
| `screens/calendar-light.webp` | Calendar | 25,452 |
| `screens/calendar-dark.webp` | Calendar (dark) | 26,584 |
| `screens/analytics-light.webp` | Analytics | 29,988 |
| `screens/analytics-dark.webp` | Analytics (dark) | 30,338 |

To refresh the screens after a UI change: `node scripts/demo/build.mjs`, serve it with
`node scripts/demo/serve.mjs 3021 demo/dist/postmind-studio-demo.html`, run
`node scripts/marketing/capture-screens.mjs`, then update the byte counts here.
