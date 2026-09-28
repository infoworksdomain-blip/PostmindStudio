import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb } from './helpers/migrated-db';

// BACKLOG 1.8 verification without Docker: every committed migration applied to an
// in-process Postgres with pgvector.

const EXPECTED_TABLES = [
  // v1.0 — spec Section 7
  'video_projects',
  'video_briefs',
  'video_scripts',
  'video_shots',
  'video_assets',
  'video_renders',
  'video_publications',
  'video_analytics',
  'provider_jobs',
  'provider_usage',
  'brand_kits',
  'voice_profiles',
  'style_memories',
  'templates',
  'scheduled_publications',
  'platform_connections',
  'approval_workflows',
  'approval_tasks',
  'system_flags',
  // v1.1 — Addendum A7
  'video_library',
  'video_library_categories',
  'video_library_tags',
  'video_library_analysis',
  'video_library_embeddings',
  'video_library_licenses',
  'text_overlays',
  'overlay_presets',
  'slideshow_slides',
  'slideshow_templates',
  'business_profiles',
  'website_scans',
  'image_library',
  'image_library_queries',
  // Phase 12 — cost caps / alerting (DERIVED)
  'cost_alerts',
  'notifications',
  'video_library_ingest_runs',
  // Phase 13
  'video_uploads',
  'domain_verifications',
  'onboarding_states',
  'safety_reviews',
  'org_policies',
  'org_cost_caps',
  'auto_publish_outbox',
  'organisation_purges',
  'notification_preferences',
  'content_safety_tasks',
  // Phase 14
  'organisation_beta',
  'beta_feedback',
  'safety_audit_items',
  // Phase 15
  'drip_queues',
  'provider_credentials',
  'data_exports',
  'business_purges',
  'publication_conversations',
  'takedown_requests',
  'share_links',
  'share_link_comments',
  'usage_events',
  'calendar_shadows',
];

let db: PGlite;

beforeAll(async () => {
  db = await createMigratedDb();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('studio schema migrations', () => {
  it('creates all 59 tables in the studio schema and nowhere else', async () => {
    const { rows } = await db.query<{ schemaname: string; tablename: string }>(
      `SELECT schemaname, tablename FROM pg_tables
       WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
    );
    expect(rows.every((r) => r.schemaname === 'studio')).toBe(true);
    expect(rows.map((r) => r.tablename).sort()).toEqual([...EXPECTED_TABLES].sort());
  });

  it('enables pgvector and supports cosine search on image embeddings', async () => {
    const embedding = (hot: number) =>
      `[${Array.from({ length: 1536 }, (_, i) => (i === hot ? 1 : 0)).join(',')}]`;
    await db.query(
      `INSERT INTO studio.image_library
         (id, "organisationId", "businessId", source, "s3Bucket", "s3Key",
          "widthPx", "heightPx", "fileSizeBytes", tags, fingerprint, embedding)
       VALUES
         ('img-a', 'org', 'biz', 'STOCK', 'b', 'a', 1, 1, 1, '{}', 'fa', $1::vector),
         ('img-b', 'org', 'biz', 'STOCK', 'b', 'b', 1, 1, 1, '{}', 'fb', $2::vector),
         ('img-c', 'org', 'biz', 'UPLOAD', 'b', 'c', 1, 1, 1, '{}', 'fc', NULL)`,
      [embedding(0), embedding(1)],
    );
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM studio.image_library WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector LIMIT 1`,
      [embedding(1)],
    );
    expect(rows[0]?.id).toBe('img-b');
  });

  it('enforces the spec unique constraints', async () => {
    await db.query(
      `INSERT INTO studio.system_flags (key, value, "updatedAt") VALUES ('studio.killSwitch', 'false', now())`,
    );
    await expect(
      db.query(
        `INSERT INTO studio.system_flags (key, value, "updatedAt") VALUES ('studio.killSwitch', 'true', now())`,
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('extends video_projects with the v1.1 source types and states', async () => {
    const { rows } = await db.query<{ label: string }>(
      `SELECT e.enumlabel AS label FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'studio' AND t.typname IN ('VideoSourceType', 'VideoProjectState')`,
    );
    const labels = rows.map((r) => r.label);
    expect(labels).toEqual(expect.arrayContaining(['LIBRARY_REFERENCE', 'SLIDESHOW', 'SCANNING']));
  });
});
