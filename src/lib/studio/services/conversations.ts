import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../../errors';
import { organisationIdParam } from './org-policy';

// BACKLOG 15.E3 — inbound conversation attribution (spec 8.8
// POST /api/studio/internal/publications/:id/attribute-conversation: "Called by Engagement when a
// comment on a Studio-published video is received. Ties conversationId to publicationId for
// cross-service analytics") and the report behind spec 15.4 ("Which Studio-generated videos drive
// the most engagement conversations? Which script hooks convert best to inbox leads? Which
// platforms generate the highest-value engagement per published video?").

export const attributeConversationInput = z
  .object({
    organisationId: organisationIdParam,
    conversationId: z.string().trim().min(1).max(128),
    kind: z.enum(['comment', 'dm', 'mention']).default('comment'),
    /** Engagement's lead classification; a conversation can become a lead later (sticky). */
    isLead: z.boolean().default(false),
    receivedAt: z.iso.datetime().optional(),
  })
  .strict();

export type AttributeConversationInput = z.infer<typeof attributeConversationInput>;

export const publicationIdParam = z.string().trim().min(1).max(64);

export interface AttributionResult {
  attributed: true;
  publicationId: string;
  conversationId: string;
  isLead: boolean;
  /** True when this conversation was already attributed (idempotent repeat). */
  repeated: boolean;
}

export async function attributeConversation(
  deps: { db: PrismaClient; now: () => number },
  publicationId: string,
  input: AttributeConversationInput,
): Promise<AttributionResult> {
  const id = publicationIdParam.safeParse(publicationId);
  if (!id.success) throw new ValidationError('Invalid publication id');
  // Tenant check: the publication must belong to the organisation Engagement names.
  const publication = await deps.db.videoPublication.findFirst({
    where: { id: id.data, organisationId: input.organisationId },
    select: { id: true },
  });
  if (!publication) throw new NotFoundError('Publication not found');
  const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date(deps.now());
  const key = { publicationId: id.data, conversationId: input.conversationId };
  const existing = await deps.db.publicationConversation.findUnique({
    where: { publicationId_conversationId: key },
  });
  if (existing) {
    const isLead = existing.isLead || input.isLead;
    if (isLead !== existing.isLead)
      await deps.db.publicationConversation.update({
        where: { id: existing.id },
        data: { isLead },
      });
    return { attributed: true, ...key, isLead, repeated: true };
  }
  await deps.db.publicationConversation.upsert({
    where: { publicationId_conversationId: key },
    create: {
      ...key,
      organisationId: input.organisationId,
      kind: input.kind,
      isLead: input.isLead,
      receivedAt,
    },
    // A concurrent duplicate won the race: keep its row, only make the lead flag sticky.
    update: input.isLead ? { isLead: true } : {},
  });
  return { attributed: true, ...key, isLead: input.isLead, repeated: false };
}

// ---------------------------------------------------------------- report

export const engagementReportQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  businessId: z.string().trim().min(1).max(128).optional(),
});

export interface EngagementRow {
  conversations: number;
  leads: number;
}

export interface EngagementReport {
  days: number;
  totals: EngagementRow & { publications: number };
  byProject: Array<
    EngagementRow & { projectId: string; name: string; hook: string | null; publications: number }
  >;
  byHook: Array<EngagementRow & { hook: string; projects: number; leadRate: number }>;
  byPlatform: Array<
    EngagementRow & { platform: string; publications: number; perPublication: number }
  >;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Conversations Engagement attributed to this organisation's publications, grouped (15.4). */
export async function engagementConversationReport(
  db: PrismaClient,
  organisationId: string,
  query: z.infer<typeof engagementReportQuery>,
  now: number,
): Promise<EngagementReport> {
  const since = new Date(now - query.days * 24 * 60 * 60 * 1000);
  const pubs = await db.videoPublication.findMany({
    where: {
      organisationId,
      state: { in: ['PUBLISHED', 'TAKEN_DOWN'] },
      publishedAt: { gte: since },
      ...(query.businessId && { project: { businessId: query.businessId } }),
    },
    select: {
      id: true,
      platform: true,
      projectId: true,
      project: { select: { name: true, brief: { select: { hook: true } } } },
    },
  });
  const convs = pubs.length
    ? await db.publicationConversation.findMany({
        where: { organisationId, publicationId: { in: pubs.map((p) => p.id) } },
        select: { publicationId: true, isLead: true },
      })
    : [];
  const perPub = new Map<string, EngagementRow>();
  for (const c of convs) {
    const row = perPub.get(c.publicationId) ?? { conversations: 0, leads: 0 };
    perPub.set(c.publicationId, {
      conversations: row.conversations + 1,
      leads: row.leads + (c.isLead ? 1 : 0),
    });
  }
  const projects = new Map<string, EngagementReport['byProject'][number]>();
  const platforms = new Map<
    string,
    { conversations: number; leads: number; publications: number }
  >();
  for (const p of pubs) {
    const stats = perPub.get(p.id) ?? { conversations: 0, leads: 0 };
    const proj = projects.get(p.projectId) ?? {
      projectId: p.projectId,
      name: p.project.name,
      hook: p.project.brief?.hook ?? null,
      publications: 0,
      conversations: 0,
      leads: 0,
    };
    projects.set(p.projectId, {
      ...proj,
      publications: proj.publications + 1,
      conversations: proj.conversations + stats.conversations,
      leads: proj.leads + stats.leads,
    });
    const plat = platforms.get(p.platform) ?? { conversations: 0, leads: 0, publications: 0 };
    platforms.set(p.platform, {
      publications: plat.publications + 1,
      conversations: plat.conversations + stats.conversations,
      leads: plat.leads + stats.leads,
    });
  }
  const hooks = new Map<string, { conversations: number; leads: number; projects: number }>();
  for (const proj of projects.values()) {
    if (!proj.hook) continue;
    const h = hooks.get(proj.hook) ?? { conversations: 0, leads: 0, projects: 0 };
    hooks.set(proj.hook, {
      projects: h.projects + 1,
      conversations: h.conversations + proj.conversations,
      leads: h.leads + proj.leads,
    });
  }
  const byConversations = (a: EngagementRow, b: EngagementRow) =>
    b.leads - a.leads || b.conversations - a.conversations;
  return {
    days: query.days,
    totals: {
      publications: pubs.length,
      conversations: convs.length,
      leads: convs.filter((c) => c.isLead).length,
    },
    byProject: [...projects.values()].sort(byConversations),
    byHook: [...hooks.entries()]
      .map(([hook, h]) => ({
        hook,
        ...h,
        leadRate: h.conversations ? round(h.leads / h.conversations) : 0,
      }))
      .sort(byConversations),
    byPlatform: [...platforms.entries()]
      .map(([platform, p]) => ({
        platform,
        ...p,
        perPublication: p.publications ? round(p.conversations / p.publications) : 0,
      }))
      .sort(byConversations),
  };
}
