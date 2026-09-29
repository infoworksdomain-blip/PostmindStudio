// Full-page navigations: after sign-in or sign-out, an organisation switch, an OAuth start, a
// Stripe or download URL, and the reload after an ownership transfer. Every call site goes through
// these so the single-file demo build can swap them (scripts/demo/build.mjs aliases this module to
// demo/shims/hard-navigate.ts, which keeps the visitor inside the hash-routed page). In the app
// they are exactly window.location.assign and window.location.reload.
//
// hardNavigate answers whether the page is actually leaving: always true here. The demo shim answers
// false when it stays on the page (a notice instead of Google or Stripe, a saved file), so a
// button that shows a spinner until the page unloads knows to stop it.
export function hardNavigate(url: string): boolean {
  window.location.assign(url);
  return true;
}

export function hardReload(): void {
  window.location.reload();
}
