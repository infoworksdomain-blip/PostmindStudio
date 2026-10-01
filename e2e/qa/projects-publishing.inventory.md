# QA 3 inventory: Projects, Approval workflows, Publications

Scope of `e2e/qa/projects-publishing.spec.ts`. States per surface: empty, loading, error, success,
permission-denied, mobile 375 px, dark mode, RTL (`ar`). Roles: owner, admin, publisher, creator, viewer
(`src/lib/identity/role-capabilities.ts`: viewer reads; creator writes and downloads; publisher also
approves and publishes; admin and owner also manage workflows, connections, members).

## Pages (3) and their components

| Page | Component | Notes |
| --- | --- | --- |
| `/projects` | `projects/projects-list.tsx` | 6 filter tabs, cursor pagination (20 per page), empty, filtered-empty, error + retry, loading skeleton. No search box and no duplicate/delete/archive controls exist in the UI (API only: see Gaps). |
| `/projects/[id]` | `review/review-screen.tsx` | Header (state badge, spend, budget), pipeline strip, failure alert, budget raise, auto-resume / safety / fallback notes, approval-step indicator, approval bar, automation panel, music + SFX status, share links, 6 tabs |
| `/approvals` | `approvals/approval-workflows-screen.tsx`, `workflow-form.tsx`, `approval-step-indicator.tsx` | list, create, edit, delete with confirm, validation problems, empty, error |
| `/publications` | `publications/publications-list.tsx`, `publication-actions.tsx`, `confirm-dialog.tsx` | 5 state tabs, platform filter, pagination, retry / cancel / take down, calendar link |

## Project detail tabs (6)

`slides` (slideshow only), `variants` (player, quality panel, thumbnail, download, re-render when stale),
`shots` (strip, shot panel: regenerate, swap, delete, narration, on-screen text), `overlays` (overlay editor:
whole-video + per-shot overlays, presets, bulk apply, timeline), `script` (view, edit, regenerate),
`publish` (publish panel + this project's posts list, auto-publish outbox, schedule notice).

## Dialogs and forms (12)

Reject / approve note; force-approve reason; publish form (per-variant account, caption, hashtags,
suggest captions, schedule datetime); cancel-scheduled confirm; take-down confirm; workflow form;
workflow delete confirm; script editor; shot regenerate prompt; shot text save; budget raise; save as template.

## API routes exercised (24)

projects: GET list, GET/PATCH/DELETE `:id`, `generate`, `cancel`, `approve`, `reject`, `approval`,
`duplicate`, `renders`, `scripts`, `caption-suggestions`, `auto-publish` (+ `retry`), `share-links`;
renders: `preview`, `download`, `rerender`; shots: regenerate, edit; publications: POST, GET list,
GET/PATCH `:id`, `cancel`, `retry`, `takedown`; approval-workflows: GET, POST, GET/PATCH/DELETE `:id`.

## Fixtures (Prisma-seeded, `fixtures.ts`)

14 projects (DRAFT, QUEUED, RENDERING, READY_FOR_REVIEW x4, QUALITY_FAILED, APPROVED x2, PUBLISHED,
PARTIALLY_PUBLISHED, FAILED, REJECTED) + 24 filler drafts for pagination; 11 renders (PASSED / FAILED);
8 publications (SCHEDULED x2, PUBLISHING, PUBLISHED, FAILED x2, CANCELLED, TAKEN_DOWN); 3 platform
connections (TikTok active, YouTube active, X needs_reconnect); 5 members (one per role) + an empty
second organisation; a STANDARD entitlement row (publishing and multi-step workflows).

## External calls

None. Object storage is `e2e/qa/s3-stub.mjs` (`AWS_ENDPOINT_URL_S3`). No publish worker runs, so a
publication stays queued; platform publishers (TikTok / YouTube / X) are never reached. Locally Redis is
v3, which BullMQ rejects: queue-dependent steps are noted in the PR.

## Gaps found while inventorying (all fixed in this PR)

- `/projects` had no search and no duplicate / delete / archive controls: added search (name, description,
  brief; debounced, kept in the URL as `?q=` and `?filter=`), an Archived filter and a per-row menu
  (Duplicate, Archive / Unarchive, Delete with confirm), hidden from roles without `studio:project:write`.
  Archive is `state = ARCHIVED` with `deletedAt` null (reversible, `metadata.archivedFrom`); Delete is the
  existing soft delete. No schema change.
- Approval workflow step roles that cannot exist in standalone mode (`client_reviewer`, `legal`, ...).
- A stored provider / platform message was shown after the translated sentence: now staff-only.
- Approve / Reject / Force-approve / Generate were shown to roles the API refuses; the upgrade dialog asked
  viewers for billing (silent 403).
- A 404 project or post showed "Couldn't load this" with a Retry: now a not-found page with a way back.
- `createPublication` / retry left a SCHEDULED row behind (and "already scheduled" on the next try) when the
  queue was down: now rolled back with a 502 `queue_unavailable`.
