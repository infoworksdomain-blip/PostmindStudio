import { NotImplementedError } from '../../errors';

// BACKLOG 15.W2 — usage events for PostMind Core billing (spec 16.1: "Studio reports usage events
// (video-generated, provider-cost-incurred) via postmind-core.internal/api/internal/usage. Core
// handles invoicing."; CLAUDE.md "Studio reports usage events"). Core has not published the
// payload, so the contract below is Studio's PROPOSAL. Studio already records every event in the
// studio.usage_events outbox (services/usage-events.ts) with state pending_setup, so nothing is
// lost while Core builds its side: once a real reporter is wired in, the backlog is sent in order.
//
// PROPOSED Core contract:
//   POST {POSTMIND_CORE_URL}/api/internal/usage
//   X-Service-Token: <POSTMIND_SERVICE_TOKEN>
//   { "events": [{
//       "idempotencyKey": "render:rnd_1",              // Studio's eventKey; Core dedupes on it
//       "organisationId": "org_1",
//       "type": "video_generated" | "provider_cost_incurred",
//       "occurredAt": "2026-10-01T09:00:00.000Z",
//       "quantity": 1,
//       "costPence": 42, "currency": "GBP",            // provider_cost_incurred only
//       "metadata": { "projectId": "prj_1", "renderId": "rnd_1", "platform": "tiktok", … }
//   }] }                                                // at most 500 events per call
//   → 202 { "accepted": 2, "duplicates": 0 }
// Studio never bills or invoices (CLAUDE.md "Do not build the payment / billing system").

export type UsageEventType = 'video_generated' | 'provider_cost_incurred';

export interface UsageEventPayload {
  idempotencyKey: string;
  organisationId: string;
  type: UsageEventType;
  occurredAt: string;
  quantity: number;
  costPence?: number;
  currency?: string;
  metadata: Record<string, unknown>;
}

export interface UsageReporter {
  /** false until Core publishes the usage API: events stay pending_setup. */
  readonly ready: boolean;
  send(events: UsageEventPayload[]): Promise<{ accepted: number }>;
}

export const USAGE_PENDING_MESSAGE = 'waiting for Core usage API (POST /api/internal/usage)';

/** The reporter until Core ships its usage API: never called by the flush (ready = false). */
export const pendingUsageReporter: UsageReporter = {
  ready: false,
  async send() {
    throw new NotImplementedError(USAGE_PENDING_MESSAGE);
  },
};
