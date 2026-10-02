# QA 6 inventory: Business & Images, Connections

Scope: `/business` (tabs profile, scan, brand, hashtags, images, learned), the header business switcher, and
`/connections`. Specs: `e2e/qa/business-images.spec.ts` (real UI, Prisma fixtures, sweep error detection).
Vitest already covers the API layer (`test/api/website-scan.test.ts`, `brand-kits.test.ts`, `connections.test.ts`,
`p18-businesses.test.ts`, `p18-meta-connect.test.ts`); the specs cover what a person sees and clicks.

## Pages and routes

| Page | File | States |
| --- | --- | --- |
| `/business` | `src/app/(studio)/business/page.tsx` | no business picked (empty), 6 tabs, `?tab=` deep link |
| `/connections` | `src/app/(studio)/connections/page.tsx` | no business, loading, error, per-platform connected / needs-reconnect / not configured, callback notice (`?connected=`, `?connection_error=`) |

## Components (by tab)

| Area | Components | Controls and states |
| --- | --- | --- |
| Header | `business-picker.tsx`, `business-context.tsx` | select (one per business), add-business form (name), cancel, duplicate-name 409, plan-limit 403, localStorage persistence, first-business form when none exist, core-mode typed id |
| Profile | `profile-panel.tsx`, `profile-review-notice.tsx` | loading, 404 empty (go to scan), error + retry, 11 editable fields, dirty/invalid/discard/save, needs-review banner + confirm, edited-by-you caption |
| Website scan | `scan-panel.tsx`, `scan-schedule.tsx`, `domain-verification.tsx`, `dispute-ownership.tsx` | URL field, ownership checkbox gate, render policy text, start (202), already-running 409 (follows running scan), 402 plan gate, 429 quota, bad URL 400; progress card (QUEUED, RUNNING, SUCCEEDED, FAILED), robots blocked, per-source library counts, warnings list, history list, schedule line, DNS verification (Enterprise), "I don't own this site" |
| Brand | `brand-kits-panel.tsx`, `brand-kit-form.tsx`, `brand-kit-media.tsx`, `voice-kit-select.tsx`, `voice-profiles-panel.tsx` (+ clone dialog, consent recorder, samples input, profile card) | list, empty, create/edit dialog (name, palette hex, fonts, tone, audience, CTAs, restricted), validation problems, make default, delete confirm, logo / watermark / intro / outro / font upload (presigned PUT), AI-label switch, voice per kit, voice clones |
| Hashtags | `hashtags/business-hashtags-panel.tsx`, `hashtag-editor.tsx` | business hashtag (derived default, custom, invalid), always-hashtags chips (add, duplicate, too many, reorder, remove), save |
| Image library | `image-library-panel.tsx`, `image-grid.tsx`, `image-library-actions.tsx` | source filter, tag filter, cursor paging, loading skeleton, empty (all / filtered), thumbnails (stored + hotlinked + no preview), semantic search (+ clear, no matches), upload (15 MB client limit, duplicate, server rejection), generate dialog (plan lock, validation, provider failure), refresh stock (no stock key), delete confirm |
| Learned | `style-memory-panel.tsx` | list, empty, edit value, pin, disable, forget |
| Connections | `connections-screen.tsx`, `platform-card.tsx`, `meta-platform-card.tsx`, `meta-deletion-status.tsx`, `checked-line.tsx`, `settings/byoc-keys-panel.tsx` | connect (oauth-init), reconnect, disconnect confirm, not configured note, add another, Meta (studio / core modes), callback success / error notices, status-check line |

## API routes touched by the UI

`GET|POST /businesses`, `GET|PATCH /businesses/:id/business-profile`, `POST /businesses/:id/scan-website`,
`GET /businesses/:id/scans`, `GET /businesses/:id/scans/schedule`, `GET /scans/:id`,
`GET|POST /businesses/:id/domain-verification` (+ `/dispute`), `GET|PUT /businesses/:id/hashtags`,
`GET /businesses/:id/style-memory`, `PATCH|DELETE /businesses/:id/style-memory/:memoryId`,
`GET|POST /brand-kits`, `PATCH|DELETE /brand-kits/:id`, `POST /brand-kits/:id/set-default`,
`POST /uploads`, `POST /uploads/:id/complete`, `GET|POST /voice-profiles`,
`GET|POST /image-library`, `DELETE /image-library/:id`, `POST /image-library/search|generate|refresh`,
`GET /platform-connections`, `DELETE /platform-connections/:id`, `POST /platform-connections/oauth-init`,
`GET /platform-connections/oauth-callback` (browser redirect from the platform).

`PATCH /businesses/:id` (rename, website address) had no UI: added in this QA as the "Business details" card on the Profile tab
(`business-details-card.tsx`). `DELETE /businesses/:id` (soft delete + 30-day purge) still has no UI: a destructive product decision, recorded in
the PR as a gap.

## Cross-cutting states checked

Empty, loading, error, success, permission denied (viewer: no write controls), mobile 375 px (no horizontal overflow),
dark mode, RTL (`ar`).

## Counts

2 pages (6 tabs + Connections), 33 components (business, hashtags, connections, picker, BYOC panel, WriteGate), 37 route
handlers behind them, 59 buttons and 48 inputs/selects/switches/file pickers, 9 scan and connection states (QUEUED, RUNNING,
SUCCEEDED, SUCCEEDED with warnings, FAILED robots, FAILED no pages, connected, needs reconnect, not configured). Specs: 28
Playwright tests in `business-images.spec.ts` (each `test` names the flow), 2 skipped locally for Redis < 5.

## Roles

Owner, viewer (read only), Basic plan (generation locked), no plan (scan stops at the upgrade dialog). A viewer sees every write
control disabled with a note saying why (`WriteGate`, `useCan`); the API still refuses what the role may not do.

## Not in this repo yet

The task text mentions a business hashtag field (it is the Hashtags tab, 20.13: covered) and presenter / avatar settings: there is no
presenter or avatar setting in this build (only the HeyGen provider adapter), so there is nothing to test.

## Not verifiable locally

- Starting a real scan and the worker: needs Redis 5+ (this machine has 3; CI has 7). The spec drives scan states with
  Prisma (as the worker would) and starts a real scan only when `queueWorks()` is true.
- Real social platform consent screens (TikTok, Google, X, LinkedIn, Meta): the authorisation hop is intercepted and the
  callback is exercised with a state created by `oauth-init`; token exchange against the platform needs live apps.
- Stock providers (Pexels has no key): the no-key path is what runs; the success path is covered by vitest with a stub source.
- AI image generation success: needs a paid provider; the plan lock, validation and failure paths are covered.
