# QA inventory: reference library and templates

Scope of QA agent 4: `/library`, `/library/[id]`, `/templates`, the staff library tab of the Admin
Centre, and the places those flow into (`/new?reference=…`, the template picker on Create, "Save as
template" on a project). Spec: `e2e/qa/library-templates.spec.ts`. Fixtures are Prisma rows; the
embedding API is replaced by `e2e/qa/embedding-stub.cjs`; thumbnails and previews are fulfilled by
Playwright routes (no storage is contacted).

State legend: E empty, L loading, X error, S success, P permission denied / plan gate, M mobile
375 px, D dark, R RTL (`ar`).

## Pages (3 + 1 admin tab)

| Page | Route | States covered |
| --- | --- | --- |
| Reference library browse | `/library` | E, L, X, S, M, D, R |
| Reference detail | `/library/[id]` | L, X (500), 404 (retired / unlicensed / unknown id), S, M, D, R |
| Templates | `/templates` | E, L, X, S, M, D, R |
| Admin Centre, Library tab | `/admin` (tab "Library") | E, X, S, P (non-staff is redirected) |

## Components (library)

| Component | File | What is exercised |
| --- | --- | --- |
| LibraryBrowse | `components/studio/library/library-browse.tsx` | grid, skeleton, empty (filters / search), error + retry, cursor pagination (Previous / More), search status line |
| LibraryFilters | `library-filters.tsx` | category select (tree, indented), length select (5 options), mood, tags, free-text search, Apply, Clear |
| RecommendedShelf | `recommended-shelf.tsx` | no business, no profile (404, link to /business), error, empty, populated, category pass-through |
| VideoCard | `video-card.tsx` | thumbnail, fallback illustration, duration, licence chip (Template + Inspire / Inspire only), match %, hover/focus preview, reduced motion |
| VideoRow | `video-row.tsx` | skeleton, empty, horizontal list |
| LibraryDetail | `library-detail.tsx` | 404 empty state, error + retry, skeleton, player (poster, controls, muted), facts, tags, back link |
| StructureSection | (in library-detail) | blueprint timeline (TEMPLATE), INSPIRE-only note, not analysed (404), error |
| BlueprintTimeline | `blueprint-timeline.tsx` | proportional strip, ordered shot list, voiceover / on-screen text icons |
| SimilarShelf | `similar-shelf.tsx` | populated, empty, error |
| UseReferencePanel | `use-reference-panel.tsx` | TEMPLATE link, INSPIRE link, locked (SCRAPED, expired), plan lock badge |
| ReferenceBanner (Create) | `create/reference-banner.tsx` | title, mode radios (disabled by licence), clear, unavailable |
| ReferencePreview (Create) | `create/reference-preview.tsx` | TEMPLATE: shot-structure strip; INSPIRE: style signature; loading, not analysed, error |
| Create `?template=` / `?slideshowTemplate=` | `create/create-screen.tsx` | applies the template picked on /templates (project: picker selected once the list loads; slideshow: Slideshow source + template) |

## Components (templates)

| Component | File | What is exercised |
| --- | --- | --- |
| TemplatesScreen | `templates/templates-screen.tsx` | loading, error + retry, own slideshow / project lists, built-ins, empty lists, Preview, Use template, delete behind a confirm dialog (toast, refresh) |
| TemplatePreviewDialog | `templates/template-preview.tsx` | formats, shot structure (blueprint strip), script outline, auto-publish note; slideshow: slides, pacing, music mood |
| ProjectTemplatePicker (Create) | `create/project-template-picker.tsx` | built-in + own templates, "No template", selection, summary line |
| SaveTemplate (project review) | `review/save-template.tsx` | name, category validation, save, 201 |
| Slideshow TemplatePicker / save | `slideshow/template-picker.tsx`, `slideshow-builder.tsx` | list, select, save as template |

## Components (staff library admin)

IngestForm, IngestStatus, LicenceAudit, LibraryAdminFilterBar, CorpusRow list, LibraryBulkBar
(accept / override / reject / reanalyse), LibraryEditDialog, ConfirmDialog (retire, reject).

## Dialogs and forms

1. Library filter form (category, length, mood, tags, search; Apply, Clear)
2. Admin: bulk-import form (URLs, licence scenario, source, category, tags)
3. Admin: edit dialog (title, description, category, tags, licence, licence source)
4. Admin: retire confirm; bulk reject confirm
5. Create: reference banner mode radios; project template radiogroup
6. Review: "Save as template" inline form

## API routes (user)

| Route | Method | Notes |
| --- | --- | --- |
| `/api/studio/library/videos` | GET | browse: category, tags, durationMin/Max, mood, cursor, limit |
| `/api/studio/library/videos/[id]` | GET | detail, signed thumbnail + 10 min preview |
| `/api/studio/library/videos/[id]/similar` | POST | nearest neighbours |
| `/api/studio/library/search` | POST | q, categorySlug, limit, cursor (offset), embedding provider |
| `/api/studio/library/recommended` | GET | businessId, category, limit; 404 without profile |
| `/api/studio/library/categories` | GET | tree |
| `/api/studio/library/blueprint/[libraryVideoId]` | GET | TEMPLATE blueprint or INSPIRE signature |
| `/api/studio/admin/library/categories` | GET | staff category tree (works without an organisation) |
| `/api/studio/templates` | GET, POST | list (built-in + own), save from project |
| `/api/studio/templates/[id]` | GET, DELETE | built-ins read-only |
| `/api/studio/slideshow-templates` | GET, POST | |
| `/api/studio/slideshow-templates/[id]` | DELETE | built-ins read-only |

## API routes (staff)

`/api/studio/admin/library/videos` (GET), `/videos/[id]` (PATCH), `/videos/[id]/retire` (POST),
`/videos/bulk` (POST), `/ingest` (POST), `/ingest/status` (GET), `/ingest/resubmit` (POST),
`/licence-audit` (GET), `/reanalyse` (POST).

## Licence rules checked

| Scenario | allowedModes | Library UI |
| --- | --- | --- |
| LICENSED, OWNED, NOT_REQUIRED | TEMPLATE + INSPIRE | both actions active, blueprint shown |
| SCRAPED | INSPIRE | "Inspire only" chip, TEMPLATE locked, blueprint withheld |
| expired licence | none usable | both actions locked (server answers 409 on create) |
| no licence row / retired | n/a | not listed, detail 404, search and similar never return it |

## Cross-cutting

Dark mode (`html.dark`), RTL (`ar`, `dir=rtl`, logical CSS), 375 px width (no horizontal overflow),
reduced-motion (no hover autoplay), keyboard (focus opens preview, Enter follows the card), console
errors and 5xx collected by the sweep's `Watcher`.

## Not verifiable locally

Real S3/R2 signed URLs and playback of real preview renditions; the real embedding provider's
ranking quality; BullMQ ingest / re-analysis jobs (needs Redis and providers: the UI is exercised
against stubbed responses); Redis caching and stable thumbnail signing (branch `p20-library-cache`).
