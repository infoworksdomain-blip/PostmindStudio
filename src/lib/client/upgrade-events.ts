// Phase 18 §3 / §P.4 — a tiny in-browser event bus for plan and billing blocks. api() emits every
// ApiError whose code means "your plan or billing stops this" (403 plan_tier / quota_exceeded,
// 402 plan_required / billing_required); the global UpgradeDialogHost (mounted in AppShell)
// subscribes and opens the upgrade dialog. No dependency on api.ts, so either side can import it.

export const UPGRADE_CODES = [
  'plan_tier',
  'quota_exceeded',
  'plan_required',
  'billing_required',
] as const;

export type UpgradeCode = (typeof UPGRADE_CODES)[number];

export interface UpgradeEvent {
  code: UpgradeCode;
  status: number;
  message: string;
  details?: Record<string, unknown>;
}

type Listener = (event: UpgradeEvent) => void;

const listeners = new Set<Listener>();

export function isUpgradeCode(code: string): code is UpgradeCode {
  return (UPGRADE_CODES as readonly string[]).includes(code);
}

/** Listen for plan / billing blocks; returns the unsubscribe function. */
export function subscribeUpgrade(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tell every listener; a throwing listener never breaks the caller or the other listeners. */
export function emitUpgrade(event: UpgradeEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // A broken listener must not turn an API error into a different error.
    }
  }
}
