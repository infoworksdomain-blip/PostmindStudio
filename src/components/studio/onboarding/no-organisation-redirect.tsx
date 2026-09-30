'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useMe } from '../account/use-me';

// A signed-in user with no organisation yet (403 no_organisation, standalone mode) has nothing any
// workspace page can load: every list answered "You don't have permission to do that" on the first
// server (2026-09-30, the superadmin created by scripts/auth/create-superadmin.ts). Send them to the
// /welcome wizard, which creates the organisation and first business. Account settings (profile,
// 2FA, password) and the staff admin area stay reachable. /account/export is not: it exports the
// organisation's data, so without one it could only say "You don't have permission" (20.10).

const ALLOWED_WITHOUT_ORGANISATION = [
  '/welcome',
  '/account/profile',
  '/account/security',
  '/admin',
] as const;

export function isAllowedWithoutOrganisation(pathname: string): boolean {
  return ALLOWED_WITHOUT_ORGANISATION.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function NoOrganisationRedirect() {
  const me = useMe();
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const noOrganisation = me.error?.code === 'no_organisation';
  useEffect(() => {
    if (noOrganisation && !isAllowedWithoutOrganisation(pathname)) router.replace('/welcome');
  }, [noOrganisation, pathname, router]);
  return null;
}
