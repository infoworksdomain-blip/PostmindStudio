'use client';

import { useMe } from './use-me';

// Operator decision 2026-10-04: generation cost is never shown to customers. Only platform staff
// (staff / superadmin) see per-video £, spend, budgets and cost caps in the studio screens. While
// /me is loading (or fails) this is false, so costs stay hidden by default.

const COST_ROLES: ReadonlySet<string> = new Set(['staff', 'superadmin']);

export function isCostViewer(platformRole: string | null | undefined): boolean {
  return platformRole != null && COST_ROLES.has(platformRole);
}

export function useShowCosts(): boolean {
  return isCostViewer(useMe().data?.me?.user?.platformRole);
}
