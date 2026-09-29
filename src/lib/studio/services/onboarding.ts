import type { OnboardingState, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';

// BACKLOG 13.14 — spec 14.5 onboarding first-run: the /welcome wizard. Phase 18 Track E order:
// (organisation → first business, both before this state exists) → Brand kit → Connect →
// First video → Celebrate. State is per (organisation, user). `suggested` tells the app shell
// whether to point the user at /welcome: not finished, not dismissed, and either already started
// or the organisation has no projects yet (existing customers are not nagged).

export const ONBOARDING_STEPS = ['brand_kit', 'connect', 'first_video', 'celebrate'] as const;
export const FIRST_STEP = ONBOARDING_STEPS[0];
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number] | 'done';

export const patchOnboardingInput = z
  .object({
    step: z.enum([...ONBOARDING_STEPS, 'done']),
    completed: z.array(z.enum(ONBOARDING_STEPS)).max(ONBOARDING_STEPS.length),
    firstVideoProjectId: z.string().min(1).max(64).nullable(),
    dismissed: z.boolean(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

function view(row: OnboardingState | null, suggested: boolean) {
  return {
    step: (row?.step ?? FIRST_STEP) as OnboardingStep,
    completed: row?.completed ?? [],
    firstVideoProjectId: row?.firstVideoProjectId ?? null,
    dismissedAt: row?.dismissedAt ?? null,
    startedAt: row?.createdAt ?? null,
    suggested,
  };
}

async function isSuggested(
  db: PrismaClient,
  organisationId: string,
  row: OnboardingState | null,
): Promise<boolean> {
  if (row?.dismissedAt || row?.step === 'done') return false;
  if (row) return true;
  const projects = await db.videoProject.count({ where: { organisationId, deletedAt: null } });
  return projects === 0;
}

const key = (tenant: TenantContext) => ({
  organisationId_userId: { organisationId: tenant.organisationId, userId: tenant.userId },
});

export async function getOnboarding(db: PrismaClient, tenant: TenantContext) {
  const row = await db.onboardingState.findUnique({ where: key(tenant) });
  return view(row, await isSuggested(db, tenant.organisationId, row));
}

export async function patchOnboarding(
  db: PrismaClient,
  tenant: TenantContext,
  input: z.infer<typeof patchOnboardingInput>,
  now: number,
) {
  if (input.firstVideoProjectId) {
    const project = await db.videoProject.findFirst({
      where: { id: input.firstVideoProjectId, organisationId: tenant.organisationId },
      select: { id: true },
    });
    if (!project)
      throw new ValidationError('firstVideoProjectId is not a project in this organisation');
  }
  // Stored in wizard order, deduplicated.
  const completed = input.completed
    ? ONBOARDING_STEPS.filter((s) => input.completed?.includes(s))
    : undefined;
  const data = {
    ...(input.step && { step: input.step }),
    ...(completed && { completed }),
    ...(input.firstVideoProjectId !== undefined && {
      firstVideoProjectId: input.firstVideoProjectId,
    }),
    ...(input.dismissed !== undefined && { dismissedAt: input.dismissed ? new Date(now) : null }),
  };
  const row = await db.onboardingState.upsert({
    where: key(tenant),
    create: {
      organisationId: tenant.organisationId,
      userId: tenant.userId,
      completed: completed ?? [],
      // The column default is the pre-Phase-18 first step; new rows start at the current one.
      step: FIRST_STEP,
      ...data,
    },
    update: data,
  });
  return view(row, await isSuggested(db, tenant.organisationId, row));
}
