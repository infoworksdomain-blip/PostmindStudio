import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { jobIds } from '@/lib/studio/queue/enqueue';
import { disputeDomain, disputeDomainInput, present } from '@/lib/studio/scan/domain-verification';
import { parseBusinessId } from '@/lib/studio/services/businesses';
import { toPlanTier } from '@/lib/studio/services/catalog';

// POST /api/studio/businesses/:id/domain-verification/dispute { reason, confirmNotOwner: true }
// A6.7 repudiation ("I do not own this site"): any plan. The business's scraped images are
// purged by a job queued now (deadline 24 h); scheduled rescans stop. 202.
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const businessId = parseBusinessId(params.id);
    const input = await parseBody(req, disputeDomainInput);
    const verification = await disputeDomain(deps, tenant, businessId, input);
    const job = {
      organisationId: tenant.organisationId,
      businessId,
      runId: verification.id,
      planTier: toPlanTier(tenant.organisation.planTier),
    };
    await deps.queue.add('purge-disputed-domain', job, { jobId: jobIds.purgeDisputedDomain(job) });
    audit(
      'studio.domain.dispute',
      { type: 'domain_verification', id: verification.id },
      { businessId, domain: verification.domain, reason: input.reason },
    );
    return { status: 202, body: { verification: present(verification) } };
  },
);
