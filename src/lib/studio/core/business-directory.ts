import { NotImplementedError } from '../../errors';

// BACKLOG 13.34 — the organisation's business list, owned by PostMind Core. Core's context
// endpoint (GET /api/internal/context/:userId) carries no businesses, and Core publishes no
// list-businesses endpoint, so Studio cannot list or verify businesses yet. The contract below is
// Studio's PROPOSAL to the Core team; nothing calls it until Core ships it.
//
// PROPOSED Core contract:
//   GET {POSTMIND_CORE_URL}/api/internal/organisations/:organisationId/businesses
//   X-Service-Token: <POSTMIND_SERVICE_TOKEN>
//   → 200 { "businesses": [{ "id": "biz_1", "name": "Leeds Sourdough", "domain": "leedssourdough.co.uk" | null }] }
//   → 404 when the organisation is unknown to Core
// Studio would cache it per organisation (5 minutes, like the context), serve it from
// GET /api/studio/businesses and validate businessId on writes against it.

export interface CoreBusiness {
  id: string;
  name: string;
  /** Omitted when Core has no website for the business. */
  domain?: string;
}

export interface CoreBusinessDirectory {
  listBusinesses(organisationId: string): Promise<CoreBusiness[]>;
}

// Phase 18 §2.11: the same contract, mode-neutral. Standalone mode implements it over
// studio.businesses (LocalBusinessDirectory, Track D); core mode keeps the Core directory.
export type Business = CoreBusiness;
export type BusinessDirectory = CoreBusinessDirectory;

export const BUSINESS_LIST_PENDING_MESSAGE =
  'waiting for Core list-businesses (GET /api/internal/organisations/:id/businesses)';

/** The directory until Core ships list-businesses: every call is an honest 501. */
export const pendingCoreBusinessDirectory: CoreBusinessDirectory = {
  async listBusinesses() {
    throw new NotImplementedError(BUSINESS_LIST_PENDING_MESSAGE);
  },
};
