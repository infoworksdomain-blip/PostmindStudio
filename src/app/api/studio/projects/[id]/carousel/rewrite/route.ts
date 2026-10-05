import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { rewriteCarousel, rewriteCarouselInput } from '@/lib/studio/services/carousels';

// POST /api/studio/projects/:id/carousel/rewrite { postId?, instruction? } (21.6) — Claude
// rewrites one post, or the whole thread when postId is absent (router, cost-tracked, at most
// MAX_CAROUSEL_REWRITES per carousel) → the saved carousel.
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    const input = await parseBody(req, rewriteCarouselInput);
    const carousel = await rewriteCarousel(
      { db: deps.db, storage: deps.storage, providers: deps.library.providers, now: deps.now },
      tenant,
      id,
      input,
    );
    audit(
      'studio.carousel.rewrite',
      { type: 'video_project', id },
      { scope: input.postId ? 'post' : 'thread' },
    );
    return { body: { carousel } };
  },
  { feature: 'carousels' },
);
