import { withPublicRoute } from '@/lib/studio/api/public';
import { parseBody } from '@/lib/studio/api/route';
import { notifySafely } from '@/lib/studio/notifications/notifier';
import { addPublicComment, shareCommentInput } from '@/lib/studio/services/share-links';

// POST /api/studio/public/share-links/:token/comments { authorName, authorEmail?, body } —
// BACKLOG 15.E5 / operator decision P8: an external reviewer leaves feedback (rate limited per
// client and per link; at most 200 comments per link). The project owner is notified
// (share_comment) and the comment is audited. Approval is NOT possible from a link.
export const POST = withPublicRoute(async ({ req, deps, params }) => {
  const input = await parseBody(req, shareCommentInput);
  const { comment, context } = await addPublicComment(deps, params.token ?? '', input);
  deps.audit({
    actorUserId: 'external:share-link',
    organisationId: context.organisationId,
    action: 'studio.share_link.comment',
    resource: { type: 'share_link', id: context.shareLinkId },
    metadata: { projectId: context.projectId, commentId: comment.id },
  });
  await notifySafely(deps, {
    organisationId: context.organisationId,
    userId: context.ownerUserId,
    kind: 'share_comment',
    title: `New feedback on ${context.projectName}`,
    body: `${comment.authorName}: ${comment.body}`.slice(0, 500),
    link: `/projects/${encodeURIComponent(context.projectId)}`,
  });
  return { status: 201, body: { comment } };
});
