// Shared in-memory publications store (owned by agent "manage"; "make" writes to it from the
// Review publish panel and auto-publish; "insight" reads it for analytics).
//
// Contract (keep these exports stable; extend freely):
//   listPublications()                  → every publication, newest first (copies)
//   getPublication(id)                  → one publication or undefined (copy)
//   publicationsForProject(projectId)   → that project's publications, newest first (copies)
//   addPublication(p)                   → stores p (id must be unique), returns a copy
//   updatePublication(id, patch)        → merges patch, returns the updated copy or undefined
//   simulatePublish(id)                 → drives a publish-now row SCHEDULED → PUBLISHING →
//                                         PUBLISHED over ~6 s (sets publishedAt, platformPostId,
//                                         platformUrl), like the publish worker would
//   onPublicationsChange(listener)      → called after every add/update; returns unsubscribe
//
// Rows use the client `Publication` shape (src/lib/client/types.ts) including the `project:
// { id, name }` join GET /publications returns — always fill `project` on rows you add. Seed data
// (publications-seed.ts) covers every state, all platforms, and dates relative to page load.
import type { Publication } from '@/lib/client/types';
import { platformPost, seedPublications } from './publications-seed';

const rows: Publication[] = seedPublications();
const listeners = new Set<() => void>();

const copy = (p: Publication): Publication => ({
  ...p,
  hashtags: [...p.hashtags],
  ...(p.project && { project: { ...p.project } }),
});
/** GET /publications order: createdAt desc, then id desc. */
const newestFirst = (a: Publication, b: Publication) =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

function changed(): void {
  for (const listener of listeners) listener();
}

export function onPublicationsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function listPublications(): Publication[] {
  return rows.map(copy).sort(newestFirst);
}

export function getPublication(id: string): Publication | undefined {
  const found = rows.find((p) => p.id === id);
  return found && copy(found);
}

export function publicationsForProject(projectId: string): Publication[] {
  return rows
    .filter((p) => p.projectId === projectId)
    .map(copy)
    .sort(newestFirst);
}

export function addPublication(p: Publication): Publication {
  const i = rows.findIndex((r) => r.id === p.id);
  if (i >= 0) rows[i] = copy(p);
  else rows.push(copy(p));
  changed();
  return copy(p);
}

export function updatePublication(
  id: string,
  patch: Partial<Publication>,
): Publication | undefined {
  const i = rows.findIndex((p) => p.id === id);
  const current = rows[i];
  if (i < 0 || !current) return undefined;
  const next = { ...current, ...patch, id };
  rows[i] = next;
  changed();
  return copy(next);
}

const PUBLISHING_AFTER_MS = 2_500;
const PUBLISHED_AFTER_MS = 6_000;

/** Publish-now simulation: the row must exist; it goes live unless it was changed meanwhile. */
export function simulatePublish(id: string): void {
  setTimeout(() => {
    const p = getPublication(id);
    if (p?.state === 'SCHEDULED') updatePublication(id, { state: 'PUBLISHING' });
  }, PUBLISHING_AFTER_MS);
  setTimeout(() => {
    const p = getPublication(id);
    if (p?.state !== 'PUBLISHING' && p?.state !== 'SCHEDULED') return;
    updatePublication(id, {
      state: 'PUBLISHED',
      publishedAt: new Date().toISOString(),
      ...platformPost(p.platform),
    });
  }, PUBLISHED_AFTER_MS);
}

// Seeded posts that are mid-upload finish like any other publish, so a project's state never
// sticks on PUBLISHING because of sample data.
for (const p of rows) if (p.state === 'PUBLISHING') simulatePublish(p.id);
