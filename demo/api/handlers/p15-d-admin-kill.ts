// Phase 15 Track D (15.D6) sample handlers: two-person approval for the global kill switch
// (spec 19.2). Shapes match src/app/api/studio/admin/kill-switch/** and
// services/kill-switch-admin.ts. The demo seeds a request from another staff member so the
// confirmation banner is visible; the demo user's own requests cannot be confirmed by them.
import { DEMO_USER_ID } from '../ids';
import { DemoHttpError, route } from '../registry';
import { setFlag } from './admin-state';

const WINDOW_MS = 10 * 60 * 1000;

interface Pending {
  requestId: string;
  requestedBy: string;
  reason: string;
  requestedAt: string;
  expiresAt: string;
}

let pending: Pending | null = {
  requestId: 'req-demo-seed',
  requestedBy: 'user-priya-oncall',
  reason: 'INC-481: Runway spend tripled in 20 minutes; halt generation while we investigate',
  requestedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 25 * 60_000).toISOString(), // longer than 10 min for the tour
};

function live(): Pending | null {
  if (pending && Date.parse(pending.expiresAt) <= Date.now()) pending = null;
  return pending;
}

/** GET /admin/kill-switch additions (merged by admin.ts). */
export function pendingGlobalState() {
  const p = live();
  return {
    pendingGlobal: p && { ...p, requestedByYou: p.requestedBy === DEMO_USER_ID },
    singleApprover: false,
  };
}

/** PUT /admin/kill-switch {level:"global", enabled:true} → 202 with a pending request. */
export function requestGlobalKill(reason: string) {
  if (live()) {
    throw new DemoHttpError(
      409,
      'conflict',
      'A global kill request is already waiting for a second staff member',
      { pending },
    );
  }
  const now = Date.now();
  pending = {
    requestId: `req-${now.toString(36)}`,
    requestedBy: DEMO_USER_ID,
    reason,
    requestedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + WINDOW_MS).toISOString(),
  };
  return { status: 202, body: { pending } };
}

route('POST', '/admin/kill-switch/global/confirm', ({ body }) => {
  const input = (body ?? {}) as { requestId?: string; reason?: string };
  if (!input.requestId || !input.reason || input.reason.trim().length < 3)
    throw new DemoHttpError(400, 'validation_error', 'requestId and a reason are required');
  const p = live();
  if (!p) throw new DemoHttpError(404, 'not_found', 'No global kill request is pending');
  if (p.requestId !== input.requestId)
    throw new DemoHttpError(409, 'conflict', 'The pending global kill request has changed');
  if (p.requestedBy === DEMO_USER_ID)
    throw new DemoHttpError(
      403,
      'forbidden',
      'A different staff member must confirm a global kill',
    );
  pending = null;
  return { flag: setFlag('global', undefined, true), request: p };
});

route('DELETE', '/admin/kill-switch/global/pending', () => {
  const p = live();
  if (!p) throw new DemoHttpError(404, 'not_found', 'No global kill request is pending');
  pending = null;
  return { withdrawn: p };
});
