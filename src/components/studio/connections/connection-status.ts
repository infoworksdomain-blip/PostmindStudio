import type { StatusTone } from '@/components/ui/status-pill';
import type { PlatformConnection } from '@/lib/client/types';

// BACKLOG 25.12 — one connection state per platform row, from what the API returns: the
// platform's accounts for this business and whether the platform's app is set up on this server.
//   connected       every account works
//   needsReconnect  at least one account lost its access (expired or revoked on the platform)
//   notConnected    no account yet
//   unavailable     the platform's app has no settings yet, so nothing can be connected
// Labels are connections.state.<state>; the reason under the row says what to do.

export type PlatformState = 'connected' | 'needsReconnect' | 'notConnected' | 'unavailable';

export const STATE_TONE: Record<PlatformState, StatusTone> = {
  connected: 'good',
  needsReconnect: 'warn',
  notConnected: 'neutral',
  unavailable: 'bad',
};

export function platformState(
  connections: ReadonlyArray<Pick<PlatformConnection, 'state'>>,
  configured: boolean,
): PlatformState {
  if (connections.some((c) => c.state === 'needs_reconnect')) return 'needsReconnect';
  if (connections.length > 0) return 'connected';
  return configured ? 'notConnected' : 'unavailable';
}
