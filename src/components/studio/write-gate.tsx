'use client';

import type { ReactNode } from 'react';
import { StudioCapability } from '@/lib/rbac';
import { useCan } from './use-can';

// Controls a role may not use stay visible but disabled, instead of a button that only ends in a
// "You don't have permission" toast. A disabled <fieldset> disables every button, input, switch
// and select inside it, whatever their depth; `contents` keeps it out of the layout. The API
// still refuses what the role may not do (requireCapability): this is the courtesy, not the lock.

export function WriteGate({
  capability = StudioCapability.ProjectWrite,
  children,
}: {
  capability?: StudioCapability;
  children: ReactNode;
}) {
  const allowed = useCan(capability);
  return (
    <fieldset disabled={!allowed} className="contents">
      {children}
    </fieldset>
  );
}
