import type { PrismaClient } from '@prisma/client';
import { listBusinesses } from '../services/businesses';
import type { Business, BusinessDirectory } from './business-directory';

// Phase 18 §2.11 — standalone mode's business list: studio.businesses (services/businesses.ts),
// behind the same contract as Core's pending directory, so GET /businesses is mode-neutral.

export function createLocalBusinessDirectory(
  db: Pick<PrismaClient, 'business'>,
): BusinessDirectory {
  return {
    async listBusinesses(organisationId): Promise<Business[]> {
      const rows = await listBusinesses(db, organisationId);
      return rows.map((b) => ({ id: b.id, name: b.name, ...(b.domain && { domain: b.domain }) }));
    },
  };
}
