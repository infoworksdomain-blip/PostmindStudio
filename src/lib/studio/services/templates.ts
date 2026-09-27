import type { Prisma, PrismaClient, Template } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import {
  assertMayConfigureTargets,
  readPublishDefaults,
  storedTargets,
  type AutoPublishTarget,
  type PublishDefaults,
} from '../automation/targets';
import { blueprintFromShots, renderScriptTemplate } from '../templates/blueprint';
import { targetFormatInput, type TargetFormatInput } from './catalog';

// Project templates (spec 8.6): GET /templates (built-in + this organisation's, ?category),
// POST /templates (save a project's shape), GET / DELETE /templates/:id. Built-in templates have
// organisationId = null and can be read by everyone but deleted by no one.

type Db = PrismaClient;

export const CATEGORY = z
  .string()
  .trim()
  .regex(/^[a-z0-9_]{1,60}$/, 'category must be lowercase letters, digits or _');

export const listTemplatesQuery = z.object({ category: CATEGORY.optional() });

export const saveTemplateInput = z.object({
  projectId: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  category: CATEGORY.default('custom'),
  /** Carry the project's publish/review policy and auto-publish targets (default true). */
  includePublishDefaults: z.boolean().default(true),
});

const visibleTo = (organisationId: string) => ({
  OR: [{ organisationId: null }, { organisationId }],
});

const storedFormat = z.object({
  platform: targetFormatInput.shape.platform,
  aspectRatio: targetFormatInput.shape.aspectRatio,
  duration: targetFormatInput.shape.durationSec,
});

/** templates.targetFormats (stored { platform, aspectRatio, duration }) → API input shape. */
export function templateFormats(value: Prisma.JsonValue): TargetFormatInput[] {
  const parsed = z.array(storedFormat).min(1).max(10).safeParse(value);
  if (!parsed.success) throw new ValidationError('Template has invalid target formats');
  return parsed.data.map((f) => ({
    platform: f.platform,
    aspectRatio: f.aspectRatio,
    durationSec: f.duration,
  }));
}

export function presentTemplate(template: Template) {
  return {
    ...template,
    builtIn: template.organisationId === null,
    publishDefaults: readPublishDefaults(template.publishDefaults),
  };
}

export async function listTemplates(db: Db, organisationId: string, category?: string) {
  const rows = await db.template.findMany({
    where: { ...visibleTo(organisationId), ...(category && { category }) },
    orderBy: [{ organisationId: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    take: 200,
  });
  return rows.map(presentTemplate);
}

export async function findTemplate(db: Db, organisationId: string, id: string) {
  const template = await db.template.findFirst({ where: { id, ...visibleTo(organisationId) } });
  if (!template) throw new NotFoundError('Template not found');
  return template;
}

export async function deleteTemplate(db: Db, organisationId: string, id: string) {
  const template = await findTemplate(db, organisationId, id);
  if (template.organisationId === null)
    throw new ForbiddenError('Built-in templates cannot be deleted');
  const deleted = await db.template.deleteMany({ where: { id, organisationId } });
  if (deleted.count === 0) throw new NotFoundError('Template not found');
}

/** "Save current project shape as a reusable template" (spec 8.6). */
export async function saveProjectTemplate(
  db: Db,
  tenant: TenantContext,
  input: z.infer<typeof saveTemplateInput>,
) {
  const project = await db.videoProject.findFirst({
    where: { id: input.projectId, organisationId: tenant.organisationId, deletedAt: null },
  });
  if (!project) throw new NotFoundError('Project not found');
  if (project.sourceType === 'SLIDESHOW')
    throw new ConflictError('Save slideshows with POST /slideshow-templates');
  const script = await db.videoScript.findFirst({
    where: { projectId: project.id },
    orderBy: { createdAt: 'asc' },
    include: {
      shots: {
        orderBy: { sortOrder: 'asc' },
        include: { overlays: { select: { presetId: true } } },
      },
    },
  });
  if (!script || script.shots.length === 0)
    throw new ValidationError('Generate the project first: a template is saved from its script');
  const targets = input.includePublishDefaults ? storedTargets(project.metadata) : [];
  assertMayConfigureTargets(tenant, targets);
  const publishDefaults: PublishDefaults | null = input.includePublishDefaults
    ? { publishPolicy: project.publishPolicy, reviewPolicy: project.reviewPolicy, targets }
    : null;
  const presetIds = [
    ...new Set(script.shots.flatMap((s) => s.overlays.flatMap((o) => o.presetId ?? []))),
  ];
  const presetName = new Map(
    (presetIds.length
      ? await db.overlayPreset.findMany({
          where: { id: { in: presetIds } },
          select: { id: true, name: true },
        })
      : []
    ).map((p) => [p.id, p.name]),
  );
  const brief = project.description?.trim() ?? '';
  return db.template.create({
    data: {
      organisationId: tenant.organisationId,
      name: input.name,
      category: input.category,
      targetFormats: project.targetFormats as Prisma.InputJsonValue,
      // The new project's own brief goes first; the saved brief is kept as context.
      scriptTemplate: brief
        ? `{{brief}}\n\nOriginal brief this template was saved from: ${brief}`.slice(0, 4_000)
        : '{{brief}}',
      shotBlueprint: blueprintFromShots(
        script.shots.map((s) => ({
          durationSec: s.durationSec,
          visualTreatment: s.visualTreatment,
          voiceoverText: s.voiceoverText,
          onScreenText: s.onScreenText,
          overlayPresetNames: s.overlays.flatMap((o) => presetName.get(o.presetId ?? '') ?? []),
        })),
      ) as unknown as Prisma.InputJsonValue,
      brandKitHints: project.brandKitId ? { brandKitId: project.brandKitId } : undefined,
      ...(publishDefaults && {
        publishDefaults: publishDefaults as unknown as Prisma.InputJsonValue,
      }),
    },
  });
}

// ------------------------------------------------------------ applying a template to a project

export interface TemplateOverrides {
  businessId: string;
  targetFormats?: TargetFormatInput[];
  brandKitId?: string;
  reviewPolicy?: PublishDefaults['reviewPolicy'];
  publishPolicy?: PublishDefaults['publishPolicy'];
  autoPublishTargets?: AutoPublishTarget[];
  briefText?: string;
  variables?: Record<string, string>;
}

export interface AppliedTemplate {
  templateId: string;
  targetFormats: TargetFormatInput[];
  brandKitId: string | undefined;
  reviewPolicy: PublishDefaults['reviewPolicy'];
  publishPolicy: PublishDefaults['publishPolicy'] | undefined;
  autoPublishTargets: AutoPublishTarget[];
  /** Rendered scriptTemplate: the brief handed to Layer 1 (with the user's own text). */
  description: string;
}

/**
 * A TEMPLATE project takes its formats, publish defaults and brief outline from the template;
 * anything the request states explicitly wins. Inherited targets for platforms the project no
 * longer renders are dropped rather than rejected.
 */
export async function applyTemplate(
  db: Db,
  organisationId: string,
  templateId: string,
  overrides: TemplateOverrides,
): Promise<AppliedTemplate> {
  const template = await db.template.findFirst({
    where: { id: templateId, ...visibleTo(organisationId) },
  });
  if (!template) throw new ValidationError('templateId is not a template available to you');
  const targetFormats = overrides.targetFormats ?? templateFormats(template.targetFormats);
  const defaults = readPublishDefaults(template.publishDefaults);
  const platforms = new Set(targetFormats.map((f) => f.platform));
  const hint = (template.brandKitHints as { brandKitId?: unknown } | null)?.brandKitId;
  const hintedKit =
    !overrides.brandKitId && typeof hint === 'string'
      ? await db.brandKit.findFirst({
          where: { id: hint, organisationId, businessId: overrides.businessId },
          select: { id: true },
        })
      : null;
  const description = renderScriptTemplate(template.scriptTemplate, {
    ...overrides.variables,
    brief: overrides.briefText ?? '',
  });
  if (!description) throw new ValidationError('brief is required: the template has no outline');
  return {
    templateId: template.id,
    targetFormats,
    brandKitId: overrides.brandKitId ?? hintedKit?.id,
    reviewPolicy: overrides.reviewPolicy ?? defaults?.reviewPolicy,
    publishPolicy: overrides.publishPolicy ?? defaults?.publishPolicy,
    autoPublishTargets:
      overrides.autoPublishTargets ??
      (defaults?.targets ?? []).filter((t) => platforms.has(t.platform)),
    description,
  };
}
