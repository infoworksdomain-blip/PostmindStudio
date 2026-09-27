import { withInternalRoute, parseInternalBody } from '@/lib/studio/api/internal';
import { ValidationError } from '@/lib/errors';
import {
  accountRefInput,
  disconnectMetaChannelByAccount,
  publicChannel,
  registerMetaChannel,
  registerMetaChannelInput,
} from '@/lib/studio/services/meta-channels';

// Internal (service-to-service, X-Service-Token; bind to private ingress) — Engagement 14.13.
//
// POST /api/studio/internal/channels — PostMind Core registers an Instagram account / Facebook
// Page after its Meta OAuth token exchange (Engagement 9.5 step 7). Idempotent upsert on
// (organisationId, platform, platformAccountId): 201 when created, 200 when updated.
export const POST = withInternalRoute(async ({ req, deps, audit }) => {
  const input = await parseInternalBody(req, registerMetaChannelInput);
  const { channel, created } = await registerMetaChannel(
    { db: deps.db, keys: deps.publishing.keys },
    input,
  );
  audit(
    channel.organisationId,
    created ? 'studio.connection.meta_register' : 'studio.connection.meta_reregister',
    { type: 'platform_connection', id: channel.id },
    { platform: channel.platform, platformAccountId: channel.platformAccountId },
  );
  return { status: created ? 201 : 200, body: { channel: publicChannel(channel), created } };
});

// DELETE /api/studio/internal/channels?organisationId=&platform=&platformAccountId= — disconnect
// by account (for callers that did not keep Studio's channel id). Tokens are wiped.
export const DELETE = withInternalRoute(async ({ req, deps, audit }) => {
  const query = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = accountRefInput.safeParse(query);
  if (!parsed.success)
    throw new ValidationError('organisationId, platform and platformAccountId are required', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  const channel = await disconnectMetaChannelByAccount(deps.db, parsed.data);
  audit(
    channel.organisationId,
    'studio.connection.meta_disconnect',
    { type: 'platform_connection', id: channel.id },
    { platform: channel.platform, platformAccountId: channel.platformAccountId },
  );
  return { body: { disconnected: true, channel: publicChannel(channel) } };
});
