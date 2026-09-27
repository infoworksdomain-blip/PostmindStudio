import { ForbiddenError } from './errors';
import type { TenantContext } from './tenant';

// Integration point 3 (Engagement handover 7.4). Call immediately after requireTenantContext.
// Capabilities are granted by PostMind Core; Studio only enforces them.

export const StudioCapability = {
  ProjectRead: 'studio:project:read',
  ProjectWrite: 'studio:project:write',
  RenderDownload: 'studio:render:download', // spec 8.4
  RenderForceApprove: 'studio:render:force-approve', // spec 13.5
  AdminKillSwitchRead: 'studio:admin:kill-switch:read',
  AdminKillSwitchWrite: 'studio:admin:kill-switch:write',
  AdminProviders: 'studio:admin:providers',
  AdminLibrary: 'studio:admin:library',
  AdminModeration: 'studio:admin:moderation',
} as const;

export type StudioCapability = (typeof StudioCapability)[keyof typeof StudioCapability];

/**
 * True when `granted` covers `required`. A grant ending in `:*` covers everything beneath
 * its prefix (`studio:admin:*` covers `studio:admin:kill-switch:write`). No other wildcards.
 */
export function capabilityMatches(granted: string, required: StudioCapability): boolean {
  if (granted === required) return true;
  if (!granted.endsWith(':*')) return false;
  return required.startsWith(granted.slice(0, -1));
}

export function hasCapability(
  context: Pick<TenantContext, 'capabilities'>,
  capability: StudioCapability,
): boolean {
  return context.capabilities.some((granted) => capabilityMatches(granted, capability));
}

export function requireCapability(
  context: Pick<TenantContext, 'capabilities'>,
  capability: StudioCapability,
): void {
  if (!hasCapability(context, capability)) {
    throw new ForbiddenError(`Missing capability ${capability}`, { capability });
  }
}
