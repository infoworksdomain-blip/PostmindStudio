import { NotImplementedError } from '../../errors';

// BACKLOG 15.W1 — PostMind Core's content library (spec 16.1: "when the user says 'make a video
// from this post', the frontend passes contentId; Studio calls
// postmind-core.internal/api/internal/content/:id for the source blob"; spec 8.8
// POST /api/studio/internal/projects/from-content; Addendum A5.1 product showcase). Core has not
// published that endpoint's response shape, so this is Studio's PROPOSAL to the Core team and
// nothing calls Core until it is agreed.
//
// PROPOSED Core contract:
//   GET {POSTMIND_CORE_URL}/api/internal/content/:contentId?organisationId=org_1
//   X-Service-Token: <POSTMIND_SERVICE_TOKEN>
//   → 200 { "content": {
//            "id": "post_77", "organisationId": "org_1", "businessId": "biz_1" | null,
//            "kind": "post" | "product",
//            "title": "Spring menu" | null,
//            "text": "Our spring menu is here…",          // the post body / product description
//            "media": [{ "url": "https://…", "type": "image" | "video" }],   // signed, short-lived
//            "product": { "name": "Sourdough loaf", "price": "£4.50", "url": "https://…" } | null
//          } }
//   → 404 when the content does not exist or belongs to another organisation
//
// Handoff (plans/phase-15.md "W1's planner change"): Track C teaches plan-project.ts to read the
// content for sourceType POSTMIND_CONTENT through this same interface. Until Core ships the
// endpoint every call is an honest 501 (NotImplementedError).

export type CoreContentKind = 'post' | 'product';

export interface CoreContentMedia {
  url: string;
  type: 'image' | 'video';
}

export interface CoreContent {
  id: string;
  organisationId: string;
  businessId: string | null;
  kind: CoreContentKind;
  title: string | null;
  text: string;
  media: CoreContentMedia[];
  product: { name: string; price?: string; url?: string } | null;
}

export interface CoreContentClient {
  /** false until Core publishes GET /api/internal/content/:id. */
  readonly ready: boolean;
  getContent(input: { organisationId: string; contentId: string }): Promise<CoreContent>;
}

export const CONTENT_PENDING_MESSAGE =
  'waiting for Core content API (GET /api/internal/content/:id)';

/** The client until Core ships the content API: every call is an honest 501. */
export const pendingCoreContentClient: CoreContentClient = {
  ready: false,
  async getContent() {
    throw new NotImplementedError(CONTENT_PENDING_MESSAGE);
  },
};
