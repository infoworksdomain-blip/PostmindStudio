import type { PrismaClient } from '@prisma/client';
import {
  ORGANISATION_EXISTS_BATCH,
  type CoreOrganisationDirectory,
} from './organisation-directory';

// Phase 18 §1 row 11 — standalone mode's organisation directory. Studio owns the organisations
// (studio.organisations, Better Auth organization plugin), so "does this organisation still
// exist" is a local query: a row that is present and not soft-deleted. The nightly
// reconciliation (services/organisation-reconciliation.ts) therefore runs for real in
// standalone mode instead of waiting for Core.

export function createLocalOrganisationDirectory(
  db: Pick<PrismaClient, 'organization'>,
): CoreOrganisationDirectory {
  return {
    ready: true,
    async existing(organisationIds) {
      const found = new Set<string>();
      for (let i = 0; i < organisationIds.length; i += ORGANISATION_EXISTS_BATCH) {
        const batch = organisationIds.slice(i, i + ORGANISATION_EXISTS_BATCH);
        const rows = await db.organization.findMany({
          where: { id: { in: batch }, deletedAt: null },
          select: { id: true },
        });
        for (const row of rows) found.add(row.id);
      }
      return found;
    },
  };
}
