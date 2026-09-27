import { withInternalRoute } from '@/lib/studio/api/internal';
import { disconnectMetaChannelById, publicChannel } from '@/lib/studio/services/meta-channels';

// Internal (X-Service-Token; bind to private ingress) — Engagement 14.13.
// DELETE /api/studio/internal/channels/:id[?organisationId=] — PostMind Core disconnects a Meta
// channel when the user disconnects it in PostMind settings. :id is the id POST returned; the
// optional organisationId must match when given. Tokens are wiped; idempotent.
export const DELETE = withInternalRoute(async ({ req, deps, params, audit }) => {
  const organisationId = new URL(req.url).searchParams.get('organisationId')?.trim() || undefined;
  const channel = await disconnectMetaChannelById(deps.db, params.id ?? '', organisationId);
  audit(
    channel.organisationId,
    'studio.connection.meta_disconnect',
    { type: 'platform_connection', id: channel.id },
    { platform: channel.platform, platformAccountId: channel.platformAccountId },
  );
  return { body: { disconnected: true, channel: publicChannel(channel) } };
});
