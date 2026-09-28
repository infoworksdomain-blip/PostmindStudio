import { createHash } from 'node:crypto';

// BACKLOG 15.B6 — composition cache key (spec 5.7: "This enables caching and cost saving on
// trivial re-renders"). The hash covers the whole edit (timeline + output), with every URL
// reduced to origin + path: signed URLs carry a fresh signature and expiry on every run, but
// the same object key means the same media. Keys are sorted so property order never matters.

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

/** sha256 of the canonical edit. */
export function edlHash(edit: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(edit)))
    .digest('hex');
}

/** The edlHash stored on a render's composition JSON, if any. */
export function storedEdlHash(composition: unknown): string | null {
  if (!composition || typeof composition !== 'object' || Array.isArray(composition)) return null;
  const hash = (composition as Record<string, unknown>).edlHash;
  return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}
