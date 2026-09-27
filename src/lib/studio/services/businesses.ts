import { z } from 'zod';
import { ValidationError } from '../../errors';

// Business ids come from PostMind Core, which exposes no endpoint to verify them (Phase 4 review
// list). Every Feature D table is therefore keyed by (organisationId, businessId): two tenants
// using the same id get two independent profiles and libraries, and neither can read, overwrite
// or block the other's.

export const businessIdParam = z.string().trim().min(1).max(128);

/** Business id from a path or form field; malformed ids are 400s. */
export function parseBusinessId(value: unknown): string {
  const parsed = businessIdParam.safeParse(value);
  if (!parsed.success) throw new ValidationError('businessId must be 1-128 characters');
  return parsed.data;
}
