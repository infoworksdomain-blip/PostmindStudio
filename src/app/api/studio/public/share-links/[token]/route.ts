import { withPublicRoute } from '@/lib/studio/api/public';
import { publicPreview } from '@/lib/studio/services/share-links';

// GET /api/studio/public/share-links/:token — BACKLOG 15.E5, spec 4.4. No session: the link
// token is the credential. → { project: { name, state }, variants[], comments[], expiresAt,
// canApprove: false }. Every miss (unknown, expired, revoked, deleted project) is the same 404.
export const GET = withPublicRoute(async ({ deps, params }) => ({
  body: await publicPreview(deps, params.token ?? ''),
}));
