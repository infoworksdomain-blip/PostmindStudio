import { NotImplementedError } from '../../errors';

// BACKLOG 15.W4 — organisation existence in PostMind Core, for spec 7.14's "Nightly
// reconciliation job: scan studio.brand_kits, studio.platform_connections, studio.video_projects
// for org IDs that no longer exist in PostMind Core; soft-delete after 30-day grace." Core has
// no list-organisations endpoint and no org.deleted event feed Studio can subscribe to (spec
// 16.2), so the contract below is Studio's PROPOSAL. Until Core ships it the nightly job
// (queue/workers/reconcile-organisations.ts) is skipped with "waiting for Core".
//
// PROPOSED Core contract (batch existence check; Studio sends the ids it holds):
//   POST {POSTMIND_CORE_URL}/api/internal/organisations/exists
//   X-Service-Token: <POSTMIND_SERVICE_TOKEN>
//   { "organisationIds": ["org_1", "org_2"] }            // at most 500 per call
//   → 200 { "existing": ["org_1"] }                      // deleted / unknown ids are omitted

export interface CoreOrganisationDirectory {
  /** false until Core ships the endpoint: reconciliation is skipped without calling it. */
  readonly ready: boolean;
  /** The subset of `organisationIds` that still exist in Core. */
  existing(organisationIds: string[]): Promise<Set<string>>;
}

export const ORGANISATION_EXISTS_BATCH = 500;

export const ORGANISATION_LIST_PENDING_MESSAGE =
  'waiting for Core organisation existence check (POST /api/internal/organisations/exists)';

/** The directory until Core ships the endpoint: every call is an honest 501. */
export const pendingCoreOrganisationDirectory: CoreOrganisationDirectory = {
  ready: false,
  async existing() {
    throw new NotImplementedError(ORGANISATION_LIST_PENDING_MESSAGE);
  },
};
