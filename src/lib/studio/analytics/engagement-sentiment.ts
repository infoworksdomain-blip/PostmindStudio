import { NotImplementedError } from '../../errors';

// BACKLOG 13.39 — comment sentiment as a style-memory signal (spec 7.2 / 10.3). Comments on
// published videos are read and classified by the sibling Engagement service, which publishes
// no sentiment/classifier API for Studio today. This is the client contract style memory
// (BACKLOG 13.29, track A4) calls; until Engagement ships the API every call throws
// NotImplementedError and style memory must skip the sentiment signal (never invent one).
//
// PROPOSED Engagement contract (not published; nothing calls it until it is):
//   POST {ENGAGEMENT_INTERNAL_URL}/api/engagement/internal/sentiment/publications
//   X-Service-Token: <POSTMIND_SERVICE_TOKEN>
//   { "organisationId": "org_1", "publications": [{ "platform": "tiktok", "platformPostId": "7301…" }] }
//   → 200 { "results": [{ "platform", "platformPostId", "commentCount", "positive", "neutral",
//                         "negative", "score", "classifiedAt" }] }
// Studio sends at most MAX_SENTIMENT_BATCH publications per call.

export const MAX_SENTIMENT_BATCH = 100;

export const SENTIMENT_PENDING_MESSAGE = "waiting for Engagement's classifier API";

export interface PublicationRef {
  platform: string;
  /** The platform's id for the post (publications.platformPostId). */
  platformPostId: string;
}

export interface PublicationSentiment extends PublicationRef {
  /** Comments Engagement classified. */
  commentCount: number;
  /** Counts per class; they sum to commentCount. */
  positive: number;
  neutral: number;
  negative: number;
  /** (positive − negative) / commentCount, in −1…1; null when commentCount is 0. */
  score: number | null;
  classifiedAt: string;
}

export interface EngagementSentimentClient {
  /** Throws NotImplementedError until Engagement publishes its classifier API. */
  publicationSentiment(input: {
    organisationId: string;
    publications: PublicationRef[];
  }): Promise<PublicationSentiment[]>;
}

export class PendingEngagementSentimentClient implements EngagementSentimentClient {
  async publicationSentiment(): Promise<PublicationSentiment[]> {
    throw new NotImplementedError(SENTIMENT_PENDING_MESSAGE);
  }
}

/** The client style memory should use; pending until Engagement ships the API. */
export function engagementSentimentClient(): EngagementSentimentClient {
  return new PendingEngagementSentimentClient();
}

/** True when the error means "sentiment not available yet": skip the signal, don't fail. */
export function isSentimentPending(err: unknown): boolean {
  return err instanceof NotImplementedError;
}
