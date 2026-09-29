import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { ANONYMISE_STEPS, NOT_PURGED_MODELS, PURGE_TABLE_STEPS } from './purge-tables';

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

  it('purges every model with an organisationId column except the tombstones and takedowns', () => {
    const kept = [
      'OrganisationPurge',
      'BusinessPurge',
      'TakedownRequest',
      // Phase 18 Track C billing records (§5.11 retention).
      'BillingCustomer',
      'Subscription',
      'TrialFingerprint',
      // Phase 18 audit trail (append-only; retention job).
      'AuditLog',
    ];
    const orgScoped = models
      .filter((m) => m.fields.some((f) => f.name === 'organisationId'))
      .map((m) => m.name)
      .filter((name) => !kept.includes(name));
    expect(orgScoped.filter((name) => !stepFor.has(name))).toEqual([]);
    for (const name of kept) expect(NOT_PURGED_MODELS[name], name).toBeDefined();
  });

  it('purges the Phase 15 organisation data, including the encrypted provider credentials', () => {
    for (const model of [
      'DataExport',
      'PublicationConversation',
      'ShareLink',
      'ShareLinkComment',
      'UsageEvent',
      'CalendarShadow',
      'DripQueue',
      'ProviderCredential',
    ])
      expect(stepFor.has(model), model).toBe(true);
  });

  it('anonymises every kept model that holds personal fields, and only kept models', () => {
    for (const step of ANONYMISE_STEPS) {
      expect(step.model in NOT_PURGED_MODELS, step.model).toBe(true);
      expect(stepFor.has(step.model)).toBe(false);
      const model = models.find((m) => m.name === step.model);
      expect(model?.dbName ?? model?.name).toBe(step.table);
    }
    const takedown = ANONYMISE_STEPS.find((s) => s.model === 'TakedownRequest');
    expect(takedown?.set.sql).toContain('"requester" = NULL');
    const hostile = `x'; DROP TABLE studio.takedown_requests; --`;
    expect(takedown?.where(hostile).sql).not.toContain(hostile);
    expect(takedown?.where(hostile).values).toContain(hostile);
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
    before('share_link_comments', 'share_links');
    before('publication_conversations', 'video_publications');
    before('calendar_shadows', 'video_publications');
    // Phase 18: the organisation row goes last, after the memberships and invitations (FKs).
    before('members', 'organisations');
    before('invitations', 'organisations');
    expect(PURGE_TABLE_STEPS.at(-1)?.table).toBe('organisations');
  });

  it('classifies the Phase 18 identity, email and billing models as the plan says', () => {
    for (const model of [
      'Organization',
      'Member',
      'Invitation',
      'Business',
      'EmailOutbox',
      'UsageCreditUse',
      'UsageCredit',
      'OrgEntitlement',
    ])
      expect(stepFor.has(model), model).toBe(true);
    for (const model of [
      'User',
      'Session',
      'Account',
      'TwoFactor',
      'Verification',
      'AuditLog',
      'EmailSuppression',
      'BillingCustomer',
      'Subscription',
      'TrialFingerprint',
      'StripeEvent',
    ])
      expect(NOT_PURGED_MODELS[model], model).toBeDefined();
  });

  it('never deletes the tombstones or the takedown record', () => {
    for (const table of ['organisation_purges', 'business_purges', 'takedown_requests'])
      expect(
        PURGE_TABLE_STEPS.some((s) => s.table === table),
        table,
      ).toBe(false);
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
