import { NotImplementedError } from '../../errors';

// BACKLOG 13.35 — Core's list of an organisation's Meta channels (Instagram accounts, Facebook
// Pages), the other side of the reconciliation in services/channel-reconciliation.ts. Core
// pushes channels to Studio (POST/DELETE /api/studio/internal/channels) but publishes no list
// endpoint, so a missed DELETE or register cannot be detected yet. PROPOSED Core contract (not
// published by Core; nothing calls it until it is):
//
//   GET {POSTMIND_CORE_URL}/api/internal/organisations/:organisationId/channels?platform=instagram,facebook
//   X-Service-Token: <POSTMIND_SERVICE_TOKEN>
//   → 200 { "channels": [{ "platform": "instagram", "platformAccountId": "17841400000000000",
//                          "platformAccountName": "@leedssourdough" }] }
//   → 404 when the organisation is unknown to Core (treated as "no channels")
//
// Tokens are never part of the list: Core keeps pushing them through the internal endpoints.

export type MetaPlatform = 'instagram' | 'facebook';

export interface CoreChannel {
  platform: MetaPlatform;
  /** Numeric Graph id (IG user id / Page id), as in POST /internal/channels. */
  platformAccountId: string;
  platformAccountName?: string;
}

export interface CoreChannelDirectory {
  /** false until Core publishes list-channels: reconciliation answers 501 without calling it. */
  readonly ready: boolean;
  listChannels(organisationId: string): Promise<CoreChannel[]>;
}

export const CHANNEL_LIST_PENDING_MESSAGE =
  'waiting for Core list-channels (GET /api/internal/organisations/:id/channels)';

/** The directory until Core ships list-channels: every call is an honest 501. */
export const pendingCoreChannelDirectory: CoreChannelDirectory = {
  ready: false,
  async listChannels() {
    throw new NotImplementedError(CHANNEL_LIST_PENDING_MESSAGE);
  },
};
