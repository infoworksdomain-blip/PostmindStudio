import { parseInternalBody, withInternalRoute } from '@/lib/studio/api/internal';
import {
  attributeConversation,
  attributeConversationInput,
} from '@/lib/studio/services/conversations';

// Internal (X-Service-Token; bind to private ingress) — BACKLOG 15.E3, spec 8.8.
// POST /api/studio/internal/publications/:id/attribute-conversation
//   { organisationId, conversationId, kind?: comment|dm|mention, isLead?, receivedAt? }
// Called by Engagement when a comment on a Studio-published video arrives. Idempotent per
// (publication, conversation); isLead is sticky. 404 when the publication is not the named
// organisation's. 200 { attributed: true, repeated }. Audited on the first attribution.
export const POST = withInternalRoute(async ({ req, deps, params, audit }) => {
  const input = await parseInternalBody(req, attributeConversationInput);
  const result = await attributeConversation(deps, params.id ?? '', input);
  if (!result.repeated)
    audit(
      input.organisationId,
      'studio.publication.attribute_conversation',
      { type: 'video_publication', id: result.publicationId },
      { conversationId: result.conversationId, kind: input.kind, isLead: result.isLead },
    );
  return { body: { ...result } };
});
