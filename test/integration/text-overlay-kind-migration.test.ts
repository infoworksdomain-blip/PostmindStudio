import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigration, createMigratedDb } from './helpers/migrated-db';

// BACKLOG 20.22 — the text_overlays.kind migration (add-only) marks the narration captions that
// overlays/voice-captions.ts already wrote (project.metadata.voiceCaptions[shotId].overlayIds) as
// 'caption'; every other existing row (headlines, CTAs, user text) stays 'on_screen'.

const MIGRATION = '20261007010000_text_overlay_kind';

describe('text_overlays.kind migration', () => {
  let db: PGlite;

  async function overlay(id: string, shotId: string, text: string) {
    await db.query(
      `INSERT INTO text_overlays ("id", "shotId", "text", "startAtSec", "endAtSec", "animationIn",
         "animationOut", "fontFamily", "fontSizePct", "fillColor", "anchorX", "anchorY", "updatedAt")
       VALUES ($1, $2, $3, 0, 1, 'fadeIn', 'fadeOut', 'Inter', 4, '#FFFFFF', 0.5, 0.7, now())`,
      [id, shotId, text],
    );
  }

  beforeAll(async () => {
    db = await createMigratedDb({ before: MIGRATION });
    const project = (metadata: unknown, id: string) =>
      db.query(
        `INSERT INTO video_projects ("id", "organisationId", "businessId", "createdByUserId", "name",
           "state", "sourceType", "targetFormats", "metadata", "updatedAt")
         VALUES ($1, 'org', 'biz', 'user', 'QA 3', 'QUALITY_FAILED', 'BRIEF', '[]', $2, now())`,
        [id, metadata === undefined ? null : JSON.stringify(metadata)],
      );
    await project(
      { runId: 'r', voiceCaptions: { s1: { voiceAssetId: 'v1', overlayIds: ['c1', 'c2'] } } },
      'p1',
    );
    await project({ voiceCaptions: 'not-an-object' }, 'p2');
    await project(undefined, 'p3');
    await db.query(
      `INSERT INTO video_scripts ("id", "projectId", "targetPlatform", "targetAspectRatio",
         "targetDurationSec", "fullText", "scriptModel", "updatedAt")
       VALUES ('sc1', 'p1', 'tiktok', '9:16', 30, 'x', 'm', now()),
              ('sc2', 'p2', 'tiktok', '9:16', 30, 'x', 'm', now())`,
    );
    await db.query(
      `INSERT INTO video_shots ("id", "scriptId", "sortOrder", "durationSec", "visualTreatment",
         "sceneDescription", "state")
       VALUES ('s1', 'sc1', 0, 3, 'AI_CLIP', 'x', 'READY'),
              ('s2', 'sc2', 0, 3, 'AI_CLIP', 'x', 'READY')`,
    );
    await overlay('c1', 's1', 'When the meeting panic hits,');
    await overlay('c2', 's1', 'AheadAI drafts your opener.');
    await overlay('h1', 's1', 'Meeting panic mode');
    await overlay('h2', 's2', 'AheadAI to the rescue');
    await applyMigration(db, MIGRATION);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('marks recorded narration captions as captions and leaves everything else on-screen', async () => {
    const rows = await db.query<{ id: string; kind: string }>(
      'SELECT "id", "kind" FROM text_overlays ORDER BY "id"',
    );
    expect(rows.rows).toEqual([
      { id: 'c1', kind: 'caption' },
      { id: 'c2', kind: 'caption' },
      { id: 'h1', kind: 'on_screen' },
      { id: 'h2', kind: 'on_screen' },
    ]);
  });

  it('new rows default to on_screen', async () => {
    await overlay('n1', 's2', 'Try it free');
    const row = await db.query<{ kind: string }>(
      `SELECT "kind" FROM text_overlays WHERE "id" = 'n1'`,
    );
    expect(row.rows[0]?.kind).toBe('on_screen');
  });
});
