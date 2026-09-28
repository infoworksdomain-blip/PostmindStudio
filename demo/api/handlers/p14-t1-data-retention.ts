// Phase 14 track 1 sample handlers. Shapes match the real route:
//   GET /admin/organisations/:id/purge-plan   14.1 (services/organisation-hard-delete.ts planHardDelete)
// The demo organisation is not purged (purge: null, a sizing dry run); any id starting with
// "org-deleted" shows a purge inside its 30-day grace.
import { DemoHttpError, route } from '../registry';

const DAY = 24 * 60 * 60 * 1000;
const SAFE_ORG = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

const TABLES: [string, number][] = [
  ['video_analytics', 336],
  ['scheduled_publications', 1],
  ['safety_audit_items', 0],
  ['auto_publish_outbox', 3],
  ['video_publications', 14],
  ['text_overlays', 41],
  ['slideshow_slides', 12],
  ['video_shots', 58],
  ['video_scripts', 17],
  ['video_briefs', 14],
  ['approval_tasks', 15],
  ['content_safety_tasks', 0],
  ['safety_reviews', 1],
  ['video_renders', 22],
  ['video_assets', 131],
  ['video_uploads', 4],
  ['provider_jobs', 402],
  ['provider_usage', 48],
  ['cost_alerts', 2],
  ['notifications', 63],
  ['notification_preferences', 5],
  ['onboarding_states', 2],
  ['beta_feedback', 0],
  ['system_flags', 0],
  ['video_projects', 14],
  ['style_memories', 5],
  ['brand_kits', 1],
  ['voice_profiles', 1],
  ['templates', 2],
  ['overlay_presets', 3],
  ['slideshow_templates', 0],
  ['image_library_queries', 6],
  ['image_library', 88],
  ['website_scans', 3],
  ['domain_verifications', 0],
  ['business_profiles', 1],
  ['platform_connections', 4],
  ['approval_workflows', 0],
  ['org_policies', 0],
  ['org_cost_caps', 0],
  ['organisation_beta', 0],
];

route('GET', '/admin/organisations/:id/purge-plan', ({ params }) => {
  const id = params.id ?? '';
  if (!SAFE_ORG.test(id)) {
    throw new DemoHttpError(
      400,
      'validation_error',
      'Organisation id is not usable as a storage prefix',
    );
  }
  const now = Date.now();
  const purged = id.startsWith('org-deleted');
  const prefix = `orgs/${id}/`;
  const storage = [
    { bucket: 'studio-assets', prefix, objects: 219, bytes: 1_874_321_004, truncated: false },
    { bucket: 'studio-renders', prefix, objects: 44, bytes: 2_310_557_812, truncated: false },
    { bucket: 'studio-thumbnails', prefix, objects: 0, bytes: 0, truncated: false },
    { bucket: 'studio-library-assets', prefix, objects: 0, bytes: 0, truncated: false },
  ];
  const tables = TABLES.map(([table, rows]) => ({ table, rows }));
  return {
    body: {
      plan: {
        organisationId: id,
        purge: purged
          ? {
              state: 'soft_deleted',
              requestedAt: new Date(now - 12 * DAY).toISOString(),
              graceUntil: new Date(now + 18 * DAY).toISOString(),
              due: false,
              hardDeletedAt: null,
              hardDeleteAttempts: 0,
              hardDeleteError: null,
              summary: null,
            }
          : null,
        tables,
        storage,
        keysOutsidePrefix: 0,
        totals: {
          rows: tables.reduce((n, t) => n + t.rows, 0),
          objects: storage.reduce((n, s) => n + s.objects, 0),
          bytes: storage.reduce((n, s) => n + s.bytes, 0),
        },
      },
    },
  };
});
