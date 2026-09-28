import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { NOT_PURGED_MODELS, PURGE_TABLE_STEPS } from './purge-tables';

// BACKLOG 14.1 — the hard delete must cover every table that can hold an organisation's data.
// This fails as soon as a model is added to prisma/schema.prisma without being either purged
// (a step in PURGE_TABLE_STEPS) or deliberately kept (NOT_PURGED_MODELS, with the reason).

const models = Prisma.dmmf.datamodel.models;
const stepFor = new Map(PURGE_TABLE_STEPS.map((s) => [s.model, s]));

describe('PURGE_TABLE_STEPS', () => {
  it('classifies every Prisma model: purged or deliberately kept', () => {
    const unclassified = models
      .map((m) => m.name)
      .filter((name) => !stepFor.has(name) && !(name in NOT_PURGED_MODELS));
    expect(unclassified).toEqual([]);
  });

  it('purges every model with an organisationId column except the tombstone', () => {
    const orgScoped = models
      .filter((m) => m.fields.some((f) => f.name === 'organisationId'))
      .map((m) => m.name)
      .filter((name) => name !== 'OrganisationPurge');
    expect(orgScoped.filter((name) => !stepFor.has(name))).toEqual([]);
  });

  it("uses each model's real table name, once", () => {
    for (const step of PURGE_TABLE_STEPS) {
      const model = models.find((m) => m.name === step.model);
      expect(model, step.model).toBeDefined();
      expect(model?.dbName ?? model?.name).toBe(step.table);
    }
    const tables = PURGE_TABLE_STEPS.map((s) => s.table);
    expect(new Set(tables).size).toBe(tables.length);
  });

  it('deletes children before the parents they reference (FK-safe order)', () => {
    const order = (table: string) => PURGE_TABLE_STEPS.findIndex((s) => s.table === table);
    const before = (child: string, parent: string) =>
      expect(order(child), `${child} before ${parent}`).toBeLessThan(order(parent));
    before('video_analytics', 'video_publications');
    before('video_publications', 'video_renders');
    before('video_publications', 'video_projects');
    before('text_overlays', 'video_shots');
    before('text_overlays', 'slideshow_slides');
    before('video_shots', 'video_scripts');
    before('video_scripts', 'video_projects');
    before('video_briefs', 'video_projects');
    before('approval_tasks', 'video_projects');
    before('video_renders', 'video_projects');
    // Steps that find rows through a parent must run while the parent still exists.
    before('scheduled_publications', 'video_publications');
    before('system_flags', 'video_projects');
    before('image_library_queries', 'business_profiles');
    before('image_library_queries', 'image_library');
    before('image_library_queries', 'website_scans');
  });

  it('never deletes the tombstone', () => {
    expect(PURGE_TABLE_STEPS.some((s) => s.table === 'organisation_purges')).toBe(false);
    expect(NOT_PURGED_MODELS.OrganisationPurge).toMatch(/tombstone/);
  });

  it('binds the organisation id as a parameter, never into the SQL text', () => {
    const hostile = `x'; DROP TABLE studio.video_projects; --`;
    for (const step of PURGE_TABLE_STEPS) {
      const sql = step.where(hostile);
      expect(sql.sql).not.toContain(hostile);
      expect(sql.values).toContain(hostile);
    }
  });
});
