# Phase 21.6 — Carousels (post cards)

Operator request, 2026-10-04. Studio makes image carousels that look like a business's own
social posts: one "post card" per slide, rendered server-side to 1080×1350 PNG, edited in Studio
and published to Instagram, Facebook, LinkedIn and TikTok.

## Source of the method

The operator supplied a public Claude Code skill, **"instagram-thread-carousel"**, and reviewed
its `SKILL.md`. Studio implements the skill's *method* natively in TypeScript. None of its Python
scripts were downloaded or run, and none of its Tavily, Giphy, Steel or Gemini keys are used.
What came from the skill:

- the post-card format: 4:5 slide, white (light) or black (dark) background, circular profile
  picture with a bold name and a grey @handle, large sans-serif text with generous line spacing,
  paragraphs, line breaks and → bullets, an optional full-width rounded picture below the text,
  content centred vertically, and two short posts stacked with a light divider;
- the slide rules: the hook gets its own slide and a picture; a post with a picture gets its own
  slide with 1–3 short lines (more text becomes an image slide with a short label plus text-only
  detail slides); posts over ~200 characters get their own slide; consecutive short posts
  (< ~150 characters, no picture) share a slide two at a time; the CTA is its own last slide;
  overflowing text is split, never shrunk below a readable minimum;
- the writing method: a scroll-stopping hook that works alone, with connected first and second
  lines; the hook frameworks Surprising Statistic, Direct Listicle, High-TAM "Everyone", Numbers
  Up Front and Direct "You"; what to avoid; one idea per post; → bullets; "waterfall" lists from
  the shortest to the longest line; contrasting pairs; 7 as the listicle sweet spot; a short CTA.

### Operator decisions (2026-10-04)

- **No blue "verified" badge** (it imitates X's verification) and **no platform logos**.
- **"Borrowed Authority" is excluded**: the skill's hook that opens with a real, named person
  conflicts with the acceptable-use policy on real people and carries defamation risk. The prompt
  forbids naming real people anywhere in the thread (and the existing script-safety gate's
  `public_figure` category still escalates any that slip through to review).
- A carousel counts as **`CAROUSEL_ALLOWANCE_UNITS = 1`** video of the plan allowance.
- **No £ cost is shown** for carousels (Create, the review header, the projects list, cancel).

## How it works

| Step | Where |
| --- | --- |
| Create → "Carousel (post cards)": look, number of posts (3–12, default 7), optional pasted thread | `components/studio/create/carousel-options.tsx`, `create/body.ts` |
| Project `sourceType CAROUSEL`, carousel in `metadata.carousel` (profile: business name, brand-kit logo, handle from a connected Instagram/TikTok/X account name that looks like a handle, else from the business name) | `services/carousels.ts` `initialCarousel`, `carousel/document.ts`, migration `20261008010000_carousels` |
| Generate (allowance checked as for any project) → `plan-project` → `plan-carousel`: Claude writes the thread when none was pasted (vague-brief and restricted-topic answers park the project in DRAFT exactly as ideation does for videos), pictures by meaning, the script-safety gate, captions per network | `queue/workers/plan-carousel.ts`, `carousel/writer.ts`, `carousel/thread-prompt.ts`, `carousel/images.ts` |
| `render-carousel`: slides rendered with sharp, stored (PNG + JPEG) in the renders bucket, one `video_renders` row (`targetPlatform 'carousel'`, `composition.kind 'carousel'`), quality checks, review | `queue/workers/render-carousel.ts`, `carousel/produce.ts`, `carousel/render.ts` |
| Editor tab: text per post, picture change/remove, reorder, add/delete, name/handle, light/dark, "Shortest line first", AI rewrite of one post or the whole thread (30 per carousel), live preview, save, render again (no AI, no allowance), ZIP and per-slide PNG downloads | `components/studio/carousel/*`, `/api/studio/projects/:id/carousel[/preview|/render|/rewrite|/download]` |
| Publish tab: one post per chosen account, each network's generated caption and hashtags | `carousel-publish-panel.tsx` → `POST /publications` → `publish-video` → `publishCarousel` |
| Plan a month: an item can be switched to "Carousel"; it becomes a CAROUSEL project going only to the plan's carousel networks | `services/content-plan-run.ts`, `plans/plan-editor.tsx` |

### Rendering (deterministic)

- Layout is computed by Studio (`carousel/layout.ts`, `breakdown.ts`, `text.ts`) from the **real
  advance widths of the bundled font files** (`carousel/font-metrics.ts` reads `head`, `hhea`,
  `hmtx` and `cmap` from `public/fonts/*.ttf`; kerning is ignored, a slight over-estimate).
- Shapes (background, avatar circle, divider, masks) are SVG; glyphs are set by libvips/Pango
  through sharp's `text` input with an explicit `fontfile` (`opsz` pinned so Inter stays on its
  text cut). SVG `<text>` was rejected: librsvg picks fonts through the host's fontconfig, which
  is not deterministic across machines. Same inputs give the same bytes (tested).
- Scripts: Latin/Greek/Cyrillic in Inter (Noto Sans after it), Arabic, Devanagari and Chinese in
  the matching Noto family with Inter after it for Latin words.
- **RTL**: Arabic slides mirror the header (avatar on the right), right-align text and use ←
  bullets.
- **Emoji** are removed from slides (preview and render alike), as are characters no bundled font
  can draw; the editor says how many. Bundling a colour-emoji font (~10 MB) and relying on host
  fallbacks were both rejected (size; non-deterministic "tofu" boxes).
- Quality checks: text inside the 90/100 px safe area (measured from the rendered ink), content
  not overflowing, pictures not stretched (aspect ratio within 1%), text contrast ≥ 4.5:1 (WCAG
  2.2 AA; both themes pass, `quality.test.ts`). A failing check makes the render `FAILED` and the
  project `QUALITY_FAILED`; a hook without a picture is only a warning.

### Pictures

No new provider or key. In order: the business's image library (pgvector search on the post's
image query), stock (Pixabay, then Unsplash, as for slideshows), then an AI-generated image
(gpt-image-2 via the existing router) within the slideshow generation budget (5 per run, 100 per
organisation per day, the tier's monthly cap). Website screenshots were **not** added: the
headless path (`STUDIO_HEADLESS_RENDER_URL` / browserless) only returns page HTML (`/content`),
not screenshots. Pictures must be stored in Studio (hotlinked library items are refused).

### AI label

`composition.aiGenerated` is true when any slide's picture is AI-generated; publishers then set
the platform's AI flag (Instagram `is_ai_generated` on the carousel container, TikTok `is_aigc`).
The editor and publish panel say so.

## Publishing (official docs, read 2026-10-04)

| Network | Studio destination | How | Limits |
| --- | --- | --- | --- |
| Instagram | `instagram_feed` | item containers (`image_url`, `is_carousel_item=true`) → `media_type=CAROUSEL` container with `children` → status → `media_publish` ([Content Publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing/), Updated Jun 30 2026; [IG User Media](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media), Updated Sep 28 2026) | 2–10 items, JPEG only, 4:5–1.91:1, width 320–1440 |
| Facebook | `facebook_feed` | `POST /{page}/photos url=… published=false` per slide → `POST /{page}/feed attached_media[i]={"media_fbid":…}` ([Page Photos v26.0](https://developers.facebook.com/docs/graph-api/reference/page/photos/)) | no limit documented; Studio's own maximum (20) |
| LinkedIn | `linkedin_video` (the LinkedIn connection) | `POST /rest/images?action=initializeUpload` → `PUT uploadUrl` (Bearer) → `POST /rest/posts content.multiImage.images[]` ([Images API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api), [MultiImage API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api), li-lms-2026-09) | 2–20 images, JPG/PNG/GIF |
| TikTok | `tiktok` | `POST /v2/post/publish/content/init/ media_type=PHOTO`, `DIRECT_POST` (video.publish) or `MEDIA_UPLOAD` to the inbox (video.upload), `source=PULL_FROM_URL`, `photo_images` ([Photo Post](https://developers.tiktok.com/doc/content-posting-api-reference-photo-post), [media transfer](https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide)) | 1–35 photos, JPEG/WebP ≤ 20 MB; **URLs must be on a domain verified for the app** |
| YouTube | — | not offered: the Data API publishes videos only | download |
| X | — | not offered: X takes at most 4 images per post and Studio's X publisher uploads video only | download |

The existing pipeline is reused: `createPublication` (carousel limits instead of the video format
check), the outbox (`renderIdFor` sends any carousel network to the carousel render), the
publish job's retries and the "never post twice" upload marker.

## Operator actions

1. **TikTok photo posts**: verify the domain (or URL prefix) that serves the slide JPEGs in the
   TikTok developer portal. Signed URLs come from `CDN_URL` when it fronts the renders bucket,
   otherwise from the storage host (R2/S3), which cannot be verified — so set up the CDN for the
   renders bucket first. Until then TikTok answers `url_ownership_unverified` (shown as a failed
   publication; nothing is posted).
2. Run the migration (`20261008010000_carousels`: two enum values, expand-only).
3. `FEATURE_CAROUSELS_ENABLED` (default on) and Admin → Features switch carousels off per
   environment, globally or per organisation.
4. Optional: review the 106 new UI strings in 10 translated catalogues (`*.review.json`).

## Not done / follow-ups

- The skill's "Borrowed Authority" hook (excluded by decision).
- Website screenshots as pictures (no screenshot endpoint in the headless path).
- Analytics polling for carousel posts runs through the existing per-network metrics fetchers;
  it has not been checked against live carousel posts.
- Month-plan mixes stay video/slideshow; carousels are chosen per item.
