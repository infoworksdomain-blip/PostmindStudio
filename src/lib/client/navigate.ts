// Full-page navigations: after sign-in or sign-out, an organisation switch, an OAuth start, a
// Stripe or download URL, and the reload after an ownership transfer. Every call site goes through
// these so the single-file demo build can swap them (scripts/demo/build.mjs aliases this module to
// demo/shims/hard-navigate.ts, which keeps the visitor inside the hash-routed page). In the app
// they are exactly window.location.assign and window.location.reload.
export function hardNavigate(url: string): void {
  window.location.assign(url);
}

export function hardReload(): void {
  window.location.reload();
}
