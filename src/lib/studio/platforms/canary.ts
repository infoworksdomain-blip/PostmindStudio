import { PlatformError } from '../../errors';
import { platformRequest } from './http';
import { DEFAULT_GRAPH_VERSION, GRAPH_HOST } from './meta';

// BACKLOG 13.31 — daily per-platform canary (.github/workflows/platform-canary.yml). Each check
// calls one READ-ONLY endpoint that the publishers / OAuth flow already depend on, with a
// sandbox account's token, and fails when the platform rejects the token or the documented
// response shape has changed. Nothing is posted: a posting canary would publish to real accounts
// every day, which is an operator decision (runbooks/platform-api-change.md).
//
// Endpoints (the same ones cited in oauth.ts, tiktok.ts and meta.ts):
//   youtube   GET https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true → items[].id
//   tiktok    POST https://open.tiktokapis.com/v2/post/publish/creator_info/query/ → data.creator_username
//   x         GET https://api.x.com/2/users/me → data.id
//   linkedin  GET https://api.linkedin.com/v2/userinfo → sub
//   instagram GET graph.facebook.com/{v}/{ig-user-id}/content_publishing_limit → data[]
//   facebook  GET graph.facebook.com/{v}/{video-id}?fields=status → status

export type CanaryPlatform = 'youtube' | 'tiktok' | 'x' | 'linkedin' | 'instagram' | 'facebook';

export interface CanaryCredentials {
  accessToken: string;
  /** Instagram: the IG user id. Facebook: a video id the page owns. */
  objectId?: string;
}

export interface CanaryResult {
  platform: CanaryPlatform;
  ok: true;
  detail: string;
}

/** Secret names per platform (GitHub Actions secrets → env). */
export const CANARY_ENV: Record<CanaryPlatform, { token: string; objectId?: string }> = {
  youtube: { token: 'CANARY_YOUTUBE_ACCESS_TOKEN' },
  tiktok: { token: 'CANARY_TIKTOK_ACCESS_TOKEN' },
  x: { token: 'CANARY_X_ACCESS_TOKEN' },
  linkedin: { token: 'CANARY_LINKEDIN_ACCESS_TOKEN' },
  instagram: { token: 'CANARY_INSTAGRAM_ACCESS_TOKEN', objectId: 'CANARY_INSTAGRAM_USER_ID' },
  facebook: { token: 'CANARY_FACEBOOK_PAGE_TOKEN', objectId: 'CANARY_FACEBOOK_VIDEO_ID' },
};

/** Credentials for a platform from env, or null when its secrets are not configured. */
export function canaryCredentials(
  platform: CanaryPlatform,
  env: Record<string, string | undefined> = process.env,
): CanaryCredentials | null {
  const names = CANARY_ENV[platform];
  const accessToken = env[names.token]?.trim();
  if (!accessToken) return null;
  if (names.objectId) {
    const objectId = env[names.objectId]?.trim();
    if (!objectId) return null;
    return { accessToken, objectId };
  }
  return { accessToken };
}

function shapeChanged(platform: CanaryPlatform, what: string): PlatformError {
  return new PlatformError(platform, 'unknown', `Canary: response has no ${what}`, false);
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function runPlatformCanary(
  platform: CanaryPlatform,
  creds: CanaryCredentials,
  fetchImpl: typeof fetch,
  graphVersion: string = DEFAULT_GRAPH_VERSION,
): Promise<CanaryResult> {
  const opts = { platform, fetchImpl };
  switch (platform) {
    case 'youtube': {
      const { body } = await platformRequest<{ items?: Array<{ id?: string }> }>(
        'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
        { method: 'GET', headers: bearer(creds.accessToken) },
        opts,
      );
      const id = body.items?.[0]?.id;
      if (!id) throw shapeChanged(platform, 'channel id');
      return { platform, ok: true, detail: `channel ${id}` };
    }
    case 'tiktok': {
      const { body } = await platformRequest<{ data?: { creator_username?: string } }>(
        'https://open.tiktokapis.com/v2/post/publish/creator_info/query/',
        {
          method: 'POST',
          headers: {
            ...bearer(creds.accessToken),
            'Content-Type': 'application/json; charset=UTF-8',
          },
          body: '{}',
        },
        opts,
      );
      const name = body.data?.creator_username;
      if (!name) throw shapeChanged(platform, 'creator_username');
      return { platform, ok: true, detail: `creator ${name}` };
    }
    case 'x': {
      const { body } = await platformRequest<{ data?: { id?: string } }>(
        'https://api.x.com/2/users/me',
        { method: 'GET', headers: bearer(creds.accessToken) },
        opts,
      );
      if (!body.data?.id) throw shapeChanged(platform, 'user id');
      return { platform, ok: true, detail: `user ${body.data.id}` };
    }
    case 'linkedin': {
      const { body } = await platformRequest<{ sub?: string }>(
        'https://api.linkedin.com/v2/userinfo',
        { method: 'GET', headers: bearer(creds.accessToken) },
        opts,
      );
      if (!body.sub) throw shapeChanged(platform, 'sub');
      return { platform, ok: true, detail: 'member resolved' };
    }
    case 'instagram': {
      const { body } = await platformRequest<{ data?: unknown[] }>(
        `${GRAPH_HOST}/${graphVersion}/${encodeURIComponent(creds.objectId ?? '')}/content_publishing_limit?fields=quota_usage`,
        { method: 'GET', headers: bearer(creds.accessToken) },
        opts,
      );
      if (!Array.isArray(body.data)) throw shapeChanged(platform, 'data[]');
      return { platform, ok: true, detail: 'publishing limit read' };
    }
    case 'facebook': {
      const { body } = await platformRequest<{ status?: unknown }>(
        `${GRAPH_HOST}/${graphVersion}/${encodeURIComponent(creds.objectId ?? '')}?fields=status`,
        { method: 'GET', headers: bearer(creds.accessToken) },
        opts,
      );
      if (!body.status) throw shapeChanged(platform, 'status');
      return { platform, ok: true, detail: 'video status read' };
    }
  }
}
