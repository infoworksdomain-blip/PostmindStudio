import type { PrismaClient } from '@prisma/client';

// BACKLOG 25.9 — where a calendar post came from: a month plan, an automation (one period of an
// automation is a month plan with automationId) or neither (made by hand, Blitz, the API). Read
// for one page of GET /publications in two indexed queries (content_plan_items.projectId,
// automations.id), never per row. The calendar labels each post with it and filters by source.

export type PublicationCampaign =
  | { kind: 'plan'; planId: string; startDate: string; days: number }
  | { kind: 'automation'; planId: string; automationId: string; name: string };

type CampaignDb = {
  contentPlanItem: Pick<PrismaClient['contentPlanItem'], 'findMany'>;
  automation: Pick<PrismaClient['automation'], 'findMany'>;
};

/** The campaign of each project that has one (projects with none are absent from the map). */
export async function campaignsForProjects(
  db: CampaignDb,
  organisationId: string,
  projectIds: readonly string[],
): Promise<Map<string, PublicationCampaign>> {
  const ids = [...new Set(projectIds)];
  const byProject = new Map<string, PublicationCampaign>();
  if (ids.length === 0) return byProject;
  const items = await db.contentPlanItem.findMany({
    where: { organisationId, projectId: { in: ids } },
    select: {
      projectId: true,
      plan: { select: { id: true, startDate: true, days: true, automationId: true } },
    },
  });
  const automationIds = [
    ...new Set(items.flatMap((i) => (i.plan.automationId ? [i.plan.automationId] : []))),
  ];
  const automations = automationIds.length
    ? await db.automation.findMany({
        where: { organisationId, id: { in: automationIds } },
        select: { id: true, name: true },
      })
    : [];
  const names = new Map(automations.map((a) => [a.id, a.name]));
  for (const { projectId, plan } of items) {
    if (!projectId || byProject.has(projectId)) continue;
    const name = plan.automationId ? names.get(plan.automationId) : undefined;
    byProject.set(
      projectId,
      plan.automationId && name !== undefined
        ? { kind: 'automation', planId: plan.id, automationId: plan.automationId, name }
        : { kind: 'plan', planId: plan.id, startDate: plan.startDate, days: plan.days },
    );
  }
  return byProject;
}
