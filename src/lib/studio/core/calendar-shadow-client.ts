import { NotImplementedError } from '../../errors';

// BACKLOG 15.W3 — shadow entries in PostMind Core's content calendar (spec 16.1: "Studio's
// scheduled publications also write shadow entries into PostMind Core's content calendar so a
// user's calendar view shows Studio videos alongside other scheduled content"). Core publishes no
// calendar API, so the contract below is Studio's PROPOSAL. Studio keeps the entry each scheduled
// publication should have in studio.calendar_shadows (services/calendar-shadows.ts) — schedule,
// reschedule and cancel are all captured there — and syncs them once Core ships the API.
//
// PROPOSED Core contract (idempotent on Studio's publication id):
//   PUT    {POSTMIND_CORE_URL}/api/internal/calendar/entries/studio:<publicationId>
//          X-Service-Token: <POSTMIND_SERVICE_TOKEN>
//          { "organisationId": "org_1", "source": "studio", "scheduledFor": "2026-10-01T09:00:00Z",
//            "platform": "tiktok", "title": "Spring menu", "link": "https://studio.postmind.ai/projects/prj_1" }
//          → 200 { "entry": { "id": "cal_1" } }
//   DELETE {POSTMIND_CORE_URL}/api/internal/calendar/entries/studio:<publicationId>?organisationId=org_1
//          → 204 (also when the entry does not exist)

export interface CalendarShadowEntry {
  publicationId: string;
  organisationId: string;
  projectId: string;
  platform: string;
  scheduledFor: string;
  title: string | null;
  link: string;
}

export interface CalendarShadowClient {
  /** false until Core publishes the calendar API: shadows stay pending_setup. */
  readonly ready: boolean;
  upsert(entry: CalendarShadowEntry): Promise<{ coreEntryId: string }>;
  remove(input: { publicationId: string; organisationId: string }): Promise<void>;
}

export const CALENDAR_PENDING_MESSAGE =
  'waiting for Core calendar API (PUT/DELETE /api/internal/calendar/entries/:id)';

/** The client until Core ships the calendar API: every call is an honest 501. */
export const pendingCalendarShadowClient: CalendarShadowClient = {
  ready: false,
  async upsert() {
    throw new NotImplementedError(CALENDAR_PENDING_MESSAGE);
  },
  async remove() {
    throw new NotImplementedError(CALENDAR_PENDING_MESSAGE);
  },
};
