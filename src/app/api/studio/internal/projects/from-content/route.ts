import { parseInternalBody, withInternalRoute } from '@/lib/studio/api/internal';
import { pendingCoreContentClient } from '@/lib/studio/core/content-client';
import { createProjectFromContent, fromContentInput } from '@/lib/studio/services/content-projects';

// Internal (X-Service-Token; bind to private ingress) — BACKLOG 15.W1, spec 8.8.
// POST /api/studio/internal/projects/from-content
//   { organisationId, userId, businessId?, contentId, targetFormats[] }
// → 201 { project: { id, state: "DRAFT", sourceRef } } once Core's content API exists
// → 501 { error: "not_implemented", message: "waiting for Core content API (…)" } until then.
// Audited as studio.project.create_from_content (system:postmind-core).
export const POST = withInternalRoute(async ({ req, deps, audit }) => {
  const input = await parseInternalBody(req, fromContentInput);
  const result = await createProjectFromContent(
    { db: deps.db, content: deps.core?.content ?? pendingCoreContentClient },
    input,
  );
  audit(
    input.organisationId,
    'studio.project.create_from_content',
    { type: 'video_project', id: result.project.id },
    { contentId: input.contentId, userId: input.userId },
  );
  return { status: 201, body: result };
});
