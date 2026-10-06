// The demo's copy of the §P.3 access gate (src/lib/studio/billing/access-gate.ts accessDecision).
// The real module imports server services (beta plans → review policy → outbox), which the
// browser bundle cannot carry, so the two route lists are repeated here; demo/tour/links.test.ts
// checks this copy against the real accessDecision route by route.

export type DemoAccess = 'full' | 'read_only' | 'none';

export type DemoAccessDecision =
  { allowed: true } | { allowed: false; code: 'plan_required' | 'billing_required' };

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Mutations a read_only organisation may still make (path under /api/studio). */
export const READ_ONLY_ALLOWLIST: readonly RegExp[] = [
  /^\/billing(\/|$)/,
  /^\/account(\/|$)/,
  /^\/org(\/|$)/,
  /^\/organisations(\/|$)/,
  /^\/members(\/|$)/,
  /^\/invitations(\/|$)/,
  /^\/notifications(\/|$)/,
  /^\/notification-preferences(\/|$)/,
  /^\/renders\/[^/]+\/download$/,
  /^\/feedback$/,
  /^\/admin(\/|$)/,
];

/** Routes that spend provider money, publish or scan: closed to an organisation with no plan. */
export const SPEND_ROUTES: readonly RegExp[] = [
  /^\/projects\/[^/]+\/generate$/,
  // 20.9 month plans: Claude writes the topics and generate makes every post.
  /^\/content-plans$/,
  /^\/content-plans\/[^/]+\/(generate|redraft)$/,
  /^\/content-plans\/[^/]+\/items\/[^/]+\/regenerate$/,
  // 22.4 / 22.5: Blitz cards are written and rendered, kept cards generate, automations make posts.
  /^\/blitz$/,
  /^\/blitz\/refill$/,
  /^\/blitz\/suggestions\/[^/]+\/decision$/,
  /^\/businesses\/[^/]+\/angles\/suggest$/,
  /^\/automations\/[^/]+\/(start|approve|resume)$/,
  /^\/automations\/[^/]+\/slots\/[^/]+$/,
  /^\/projects\/[^/]+\/auto-populate$/,
  /^\/projects\/[^/]+\/auto-publish(\/retry)?$/,
  /^\/projects\/[^/]+\/caption-suggestions$/,
  /^\/projects\/[^/]+\/scripts$/,
  /^\/projects\/[^/]+\/slides$/,
  /^\/scripts\/[^/]+\/regenerate$/,
  /^\/shots\/[^/]+\/regenerate$/,
  /^\/renders\/[^/]+\/rerender$/,
  /^\/renders\/[^/]+\/preview$/,
  /^\/renders\/[^/]+\/overlays(\/bulk)?$/,
  /^\/overlays\/[^/]+\/preview$/,
  /^\/publications$/,
  /^\/publications\/[^/]+\/retry$/,
  /^\/businesses\/[^/]+\/scan-website$/,
  /^\/businesses\/[^/]+\/scans\/schedule$/,
  /^\/image-library\/(generate|refresh)$/,
  /^\/brand-kits\/extract$/,
  /^\/voice-profiles$/,
  /^\/voice-profiles\/[^/]+\/preview$/,
  /^\/uploads\/[^/]+\/complete$/,
];

/** `path` is the path under /api/studio, e.g. "/projects/p1/generate". */
export function demoAccessDecision(
  access: DemoAccess,
  method: string,
  path: string,
): DemoAccessDecision {
  if (access === 'full') return { allowed: true };
  const m = method.toUpperCase();
  if (READ_METHODS.has(m)) return { allowed: true };
  if (access === 'none') {
    return SPEND_ROUTES.some((re) => re.test(path))
      ? { allowed: false, code: 'plan_required' }
      : { allowed: true };
  }
  if (m === 'DELETE') return { allowed: true };
  return READ_ONLY_ALLOWLIST.some((re) => re.test(path))
    ? { allowed: true }
    : { allowed: false, code: 'billing_required' };
}
