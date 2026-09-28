import { createHash } from 'node:crypto';

// BACKLOG 15.B6 — composition cache key (spec 5.7: "This enables caching and cost saving on
// trivial re-renders"). The hash covers the whole edit (timeline + output), with every URL
// reduced to origin + path: signed URLs carry a fresh signature and expiry on every run, but
// the same object key means the same media. Keys are sorted so property order never matters.
// A URL is not proof of identical CONTENT, though: an object can be rewritten under the same key
// (a re-voiced shot, 13.1), so the caller also passes the media identities the edit was built
// from (asset ids: a new voice take or visual is a new video_assets row). A changed narration
// therefore always changes the hash and composition runs again.

/** What the edit was built from, beyond its JSON: per shot, the visual and voice asset ids. */
export interface EdlMediaInputs {
  shots?: Array<{ id: string; assetId: string | null; voiceAssetId: string | null }>;
}

function stripQuery(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonical(v)]));
  }
  return typeof value === 'string' ? stripQuery(value) : value;
}

/** sha256 of the canonical edit and the media identities it was built from. */
export function edlHash(edit: Record<string, unknown>, media: EdlMediaInputs = {}): string {
  const hash = createHash('sha256').update(JSON.stringify(canonical(edit)));
  if (media.shots?.length)
    hash.update(
      JSON.stringify(media.shots.map((s) => [s.id, s.assetId ?? null, s.voiceAssetId ?? null])),
    );
  return hash.digest('hex');
}

/** The edlHash stored on a render's composition JSON, if any. */
export function storedEdlHash(composition: unknown): string | null {
  if (!composition || typeof composition !== 'object' || Array.isArray(composition)) return null;
  const hash = (composition as Record<string, unknown>).edlHash;
  return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}
