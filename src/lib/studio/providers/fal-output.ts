// BACKLOG 24.1 review: fal's result body names the clip URL, and Layer 3 downloads that URL
// server-side (pipeline/persist.ts copyUrlToStorage). Only fal's own hosts are accepted so a
// tampered or unexpected body cannot point the download anywhere else (SSRF).
//
// fal CDN hosts, from https://fal.ai/docs/documentation/model-apis/fal-cdn.md (read 2026-10-07):
// outputs are "returned as CDN URLs" on v3.fal.media / v3b.fal.media (e.g.
// https://v3b.fal.media/files/b/{prefix}/{filename}) with fal.media as the fallback endpoint;
// fal.run is fal's own domain (queue.fal.run, fal.run).

const ALLOWED_SUFFIXES = ['.fal.media', '.fal.run'] as const;
const ALLOWED_HOSTS = ['fal.media'] as const;

export type FalOutputUrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/** Accept only https URLs on fal's CDN, without credentials. The reason never echoes the query. */
export function checkFalOutputUrl(value: unknown): FalOutputUrlCheck {
  if (typeof value !== 'string' || value === '') {
    return { ok: false, reason: 'fal request completed without a video URL' };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: 'fal returned a video URL that is not a URL' };
  }
  const where = `${parsed.protocol}//${parsed.hostname}`;
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: `fal video URL is not https (${where})` };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: `fal video URL carries credentials (${where})` };
  }
  const host = parsed.hostname.toLowerCase();
  const allowed =
    (ALLOWED_HOSTS as readonly string[]).includes(host) ||
    ALLOWED_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (!allowed) return { ok: false, reason: `fal video URL is not on fal's CDN (${where})` };
  return { ok: true, url: parsed.href };
}
