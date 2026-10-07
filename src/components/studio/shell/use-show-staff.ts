'use client';

import { useMe } from '../account/use-me';

// Standalone knows the platform role (Phase 18): the staff entries show only once /me confirms a
// staff or superadmin account, so they never flash while /me loads or appear when /me fails (a
// user with no organisation yet, a lapsed plan). Core mode has no role here, so the entries show
// and the admin routes enforce staff access themselves.
export function useShowStaff(): boolean {
  const me = useMe();
  const role = me.data?.me.user.platformRole;
  return me.data?.me.identityMode === 'core' || role === 'staff' || role === 'superadmin';
}
