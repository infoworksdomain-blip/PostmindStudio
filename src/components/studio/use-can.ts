'use client';

import { hasCapability, type StudioCapability } from '@/lib/rbac';
import { useMe } from './account/use-me';

/**
 * Whether the signed-in user may use a capability, by the same rule the API applies
 * (requireCapability). While /me has not loaded (or failed) the answer is `whileUnknown`: true by
 * default, so a control never flickers away and tests without a /me stub keep working (the API
 * still refuses what is not allowed); pass false before making a request the role may not make.
 */
export function useCan(capability: StudioCapability, whileUnknown = true): boolean {
  const { data } = useMe();
  const capabilities = data?.me?.capabilities;
  if (!capabilities) return whileUnknown;
  return hasCapability({ capabilities }, capability);
}
