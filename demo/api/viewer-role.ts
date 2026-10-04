// Who the demo visitor is seen as (GET /me user.platformRole). 21.5 (operator decision
// 2026-10-04): generation cost is never shown to customers; only platform staff see per-video
// cost, spend, budgets and cost caps (src/components/studio/account/use-show-costs.ts). The
// sample user Amara is the bakery's owner, so the customer screens are seen as a customer
// ('user') and show no costs; the Admin Centre (#/admin…) is seen as PostMind staff
// ('superadmin'), with costs. The role follows the route (demo/tour-params.ts sets it on every
// navigation), and screens re-fetch /me when it changes (tour/billing-switcher.tsx).

export type ViewerRole = 'customer' | 'staff';

let role: ViewerRole = 'customer';
const listeners = new Set<() => void>();

export function viewerRole(): ViewerRole {
  return role;
}

/** The platform role GET /me reports for the current viewer. */
export function platformRole(): 'user' | 'superadmin' {
  return role === 'staff' ? 'superadmin' : 'user';
}

/** Staff on the Admin Centre routes, a customer everywhere else. */
export function roleForPath(pathname: string): ViewerRole {
  return pathname === '/admin' || pathname.startsWith('/admin/') ? 'staff' : 'customer';
}

export function setViewerRole(next: ViewerRole): void {
  if (next === role) return;
  role = next;
  for (const listener of [...listeners]) listener();
}

export function subscribeViewerRole(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
