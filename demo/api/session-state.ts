// Whether the demo visitor is signed in as the sample user (Amara, owner of Leeds Sourdough).
// In memory only, and signed OUT when the page opens: the demo starts on the real landing page,
// as a first-time visitor sees Studio. Signing in (any email and password on the sign-in screen,
// the "Enter app as sample user" shortcut, or verifying a new sign-up) signs in; the user menu's
// "Sign out" signs out again, back to the landing page with a "Sign back in (demo)" action.
// Better Auth's stand-in (./auth.ts) flips it on sign-in and sign-out.

let signedIn = false;
/** The visitor signed out during this visit (the landing page then offers "Sign back in"). */
let signedOutByUser = false;
const listeners = new Set<() => void>();

export function isSignedIn(): boolean {
  return signedIn;
}

export function hasSignedOut(): boolean {
  return signedOutByUser;
}

export function setSignedIn(value: boolean, options: { byUser?: boolean } = {}): void {
  if (value === signedIn) return;
  signedIn = value;
  signedOutByUser = !value && options.byUser === true;
  for (const listener of [...listeners]) listener();
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
