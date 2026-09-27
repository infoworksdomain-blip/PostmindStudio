import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  getDomainVerification,
  present,
  startDomainVerification,
  startDomainVerificationInput,
} from '@/lib/studio/scan/domain-verification';
import { parseBusinessId } from '@/lib/studio/services/businesses';

// BACKLOG 13.11 (A6.7, Enterprise) — DNS TXT ownership verification for a business's website.
// POST { domain } → 201 with the TXT record to publish (200 when that request already exists);
// GET → the business's current verification. A poll job checks DNS every 10 minutes.
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const businessId = parseBusinessId(params.id);
    const input = await parseBody(req, startDomainVerificationInput);
    const { verification, created } = await startDomainVerification(
      deps,
      tenant,
      businessId,
      input,
    );
    if (created)
      audit(
        'studio.domain.verification_start',
        { type: 'domain_verification', id: verification.id },
        { businessId, domain: verification.domain },
      );
    return { status: created ? 201 : 200, body: { verification: present(verification) } };
  },
);

export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => {
    const row = await getDomainVerification(deps.db, {
      organisationId: tenant.organisationId,
      businessId: parseBusinessId(params.id),
    });
    return { body: { verification: present(row) } };
  },
);
