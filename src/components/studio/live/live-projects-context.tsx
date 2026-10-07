'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { LiveProjectEvent } from '@/lib/studio/live/events';
import type { LiveProjects } from './use-live-projects';

// 24.2 — the screen's live statuses for its cards (calendar events, planned posts, plan items)
// without threading them through every grid component. Outside a provider: no live status.

const NONE: LiveProjects = { mode: 'polling', statuses: new Map() };
const LiveProjectsContext = createContext<LiveProjects>(NONE);

export function LiveProjectsProvider({
  value,
  children,
}: {
  value: LiveProjects;
  children: ReactNode;
}) {
  return <LiveProjectsContext.Provider value={value}>{children}</LiveProjectsContext.Provider>;
}

export function useLiveStatus(projectId: string | null | undefined): LiveProjectEvent | undefined {
  const { statuses } = useContext(LiveProjectsContext);
  return projectId ? statuses.get(projectId) : undefined;
}

export function useLiveMode(): LiveProjects['mode'] {
  return useContext(LiveProjectsContext).mode;
}
