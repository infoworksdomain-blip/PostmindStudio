import type { Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { AuditEntry } from '../../audit';
import { BillingRequiredError, PlanRequiredError } from '../../errors';
import type { TenantAccess } from '../../tenant';
import type { JobName } from '../queue/queues';
import type { EntitlementsReader } from './entitlements-reader';

// Phase 18 §P.3 — the worker half of the access gate (the API half is access-gate.ts), checked
// at job start next to the kill switch (queue/workers/runtime.ts), so work queued before billing
// changed pauses cleanly:
//   generate / render / scan jobs: throw 402 plan_required / billing_required (not retried; the
//     project fails with that reason and can be generated again once billing is fixed);
//   publish jobs: HELD, not cancelled. The publication stays SCHEDULED with metadata.billingHold,
//     the job completes as a no-op, and the 17.2 re-enqueue sweep (lost-publications.ts) publishes
//     it once access is full again (it skips held publications while access is not full).

export type JobGate = 'spend' | 'publish';

export const GATED_JOBS: Partial<Record<JobName, JobGate>> = {
  'plan-project': 'spend',
  'generate-asset': 'spend',
  'compose-video': 'spend',
  'populate-slideshow': 'spend',
  'scan-website': 'spend',
  'draft-content-plan': 'spend',
  'rescan-website': 'spend',
  'refresh-image-library': 'spend',
  'publish-video': 'publish',
  'fire-scheduled-publication': 'publish',
};

/** Access of an organisation for workers (the entitlements reader, 30 s cache). */
export type BillingAccessLookup = (organisationId: string) => Promise<TenantAccess>;

export function billingAccessFrom(reader: EntitlementsReader): BillingAccessLookup {
  return async (organisationId) => (await reader.forOrganisation(organisationId)).access;
}

export interface JobAccessDeps {
  db: Pick<PrismaClient, 'videoPublication'>;
  billingAccess?: BillingAccessLookup;
  audit: (entry: AuditEntry) => void;
  logger: Logger;
  now: () => number;
}

export const BILLING_HOLD_ACTOR = 'system:studio-billing';

async function holdPublication(
  deps: JobAccessDeps,
  data: { organisationId: string; publicationId?: string },
  access: TenantAccess,
): Promise<void> {
  if (!data.publicationId) return;
  const publication = await deps.db.videoPublication.findFirst({
    where: { id: data.publicationId, organisationId: data.organisationId, state: 'SCHEDULED' },
    select: { id: true, metadata: true },
  });
  if (!publication) return;
  const meta =
    publication.metadata &&
    typeof publication.metadata === 'object' &&
    !Array.isArray(publication.metadata)
      ? (publication.metadata as Record<string, unknown>)
      : {};
  if (meta.billingHold) return; // already held (a retry of the same job)
  const at = new Date(deps.now()).toISOString();
  await deps.db.videoPublication.updateMany({
    where: { id: publication.id, state: 'SCHEDULED' },
    data: { metadata: { ...meta, billingHold: { at, access } } as Prisma.InputJsonValue },
  });
  deps.audit({
    actorUserId: BILLING_HOLD_ACTOR,
    organisationId: data.organisationId,
    action: 'studio.publication.billing_hold',
    resource: { type: 'video_publication', id: publication.id },
    metadata: { access },
  });
}

/**
 * 'run' = go ahead; 'held' = a publish job was held (the caller returns without running it).
 * Throws PlanRequiredError / BillingRequiredError for a spend job.
 */
export async function checkJobAccess(
  deps: JobAccessDeps,
  name: JobName,
  data: { organisationId: string; publicationId?: string },
): Promise<'run' | 'held'> {
  const gate = GATED_JOBS[name];
  if (!gate || !deps.billingAccess) return 'run';
  const access = await deps.billingAccess(data.organisationId);
  if (access === 'full') return 'run';
  if (gate === 'publish') {
    await holdPublication(deps, data, access);
    deps.logger.info(
      { job: name, organisationId: data.organisationId, publicationId: data.publicationId, access },
      'publish job held: billing access is not full',
    );
    return 'held';
  }
  if (access === 'none')
    throw new PlanRequiredError('The organisation has no plan: generation is paused', { access });
  throw new BillingRequiredError('Billing needs attention: generation is paused', { access });
}

/** The re-drive job id suffix for a publication held by billing (lost-publications.ts). */
export function billingHoldOf(metadata: Prisma.JsonValue | null): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const hold = (metadata as Record<string, unknown>).billingHold as { at?: unknown } | undefined;
  return hold && typeof hold.at === 'string' ? hold.at : null;
}
