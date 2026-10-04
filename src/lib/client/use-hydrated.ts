import { useSyncExternalStore } from 'react';

// Hydration-safe rendering (React error #418). The server renders Client Components in its own
// time zone, without the visitor's saved theme or browser APIs; the first client render must
// produce the same HTML. Anything that depends on the browser (the time zone, "today", the
// saved theme) renders a neutral placeholder until hydration has finished, then the real value.
// useSyncExternalStore gives false for the server render and the hydration pass, and true for
// every render after it (including components mounted later on client-side navigation), without
// an extra effect-driven re-render.
// https://react.dev/reference/react/useSyncExternalStore#adding-support-for-server-rendering

const noSubscribe = () => () => undefined;
const onClient = () => true;
const onServer = () => false;

/** False during the server render and hydration, true once running in the browser. */
export function useHydrated(): boolean {
  return useSyncExternalStore(noSubscribe, onClient, onServer);
}
