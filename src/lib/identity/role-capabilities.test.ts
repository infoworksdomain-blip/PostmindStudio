import { describe, expect, it } from 'vitest';
import { hasCapability, StudioCapability as C } from '../rbac';
import {
  capabilitiesFor,
  capabilitiesForPlatformRole,
  capabilitiesForRole,
  ORG_ROLES,
  ROLE_CAPABILITIES,
  toPlatformRole,
} from './role-capabilities';

const can = (role: string, capability: C) =>
  hasCapability({ capabilities: capabilitiesForRole(role) }, capability);

describe('organisation role → capabilities (Phase 18 §2.4)', () => {
  it('never gives an organisation role a wildcard or any admin capability', () => {
    for (const role of ORG_ROLES) {
      for (const cap of ROLE_CAPABILITIES[role]) {
        expect(cap, role).not.toContain('*');
        expect(cap.startsWith('studio:admin:'), `${role}: ${cap}`).toBe(false);
      }
    }
  });

  it.each([
    [
      'owner',
      [C.BillingManage, C.OrgDelete, C.MembersManage, C.RenderForceApprove, C.ProjectWrite],
    ],
    ['admin', [C.MembersManage, C.OrgManage, C.AuditRead, C.BillingRead, C.ConnectionsManage]],
    ['publisher', [C.ProjectApprove, C.PublicationWrite, C.RenderDownload]],
    ['creator', [C.ProjectWrite, C.RenderDownload, C.ProjectRead]],
    ['viewer', [C.ProjectRead]],
  ] as const)('%s has what the table grants', (role, caps) => {
    for (const cap of caps) expect(can(role, cap), cap).toBe(true);
  });

  it.each([
    ['admin', [C.BillingManage, C.OrgDelete]],
    ['publisher', [C.RenderForceApprove, C.ConnectionsManage, C.BusinessManage, C.MembersManage]],
    ['creator', [C.ProjectApprove, C.PublicationWrite]],
    ['viewer', [C.RenderDownload, C.ProjectWrite]],
  ] as const)('%s lacks what the table withholds', (role, caps) => {
    for (const cap of caps) expect(can(role, cap), cap).toBe(false);
  });

  it('gives an unknown role nothing', () => {
    expect(capabilitiesForRole('member')).toEqual([]);
    expect(capabilitiesForRole('')).toEqual([]);
  });

  it('keeps creators from approving their own work (ProjectApprove separation)', () => {
    expect(can('creator', C.ProjectWrite)).toBe(true);
    expect(can('creator', C.ProjectApprove)).toBe(false);
  });
});

describe('platform role → capabilities (Phase 18 §2.5)', () => {
  it('grants staff capabilities only with two-factor authentication', () => {
    expect(capabilitiesForPlatformRole('staff', false)).toEqual([]);
    expect(capabilitiesForPlatformRole('superadmin', false)).toEqual([]);
    expect(capabilitiesForPlatformRole('superadmin', true)).toEqual(['studio:admin:*']);
    expect(capabilitiesForPlatformRole('user', true)).toEqual([]);
  });

  it('gives staff the read / moderation tools, not kill-switch writes or redrive', () => {
    const staff = { capabilities: capabilitiesForPlatformRole('staff', true) };
    expect(hasCapability(staff, C.AdminKillSwitchRead)).toBe(true);
    expect(hasCapability(staff, C.AdminModeration)).toBe(true);
    expect(hasCapability(staff, C.AdminKillSwitchWrite)).toBe(false);
    expect(hasCapability(staff, C.AdminRedrive)).toBe(false);
    expect(hasCapability(staff, C.AdminImpersonate)).toBe(false);
  });

  it('reads unexpected users.role values as a plain user', () => {
    expect(toPlatformRole('superadmin')).toBe('superadmin');
    expect(toPlatformRole('admin')).toBe('user');
    expect(toPlatformRole(null)).toBe('user');
  });

  it('merges org and staff capabilities without duplicates', () => {
    const caps = capabilitiesFor({
      orgRole: 'viewer',
      platformRole: 'staff',
      twoFactorEnabled: true,
    });
    expect(caps).toContain(C.ProjectRead);
    expect(caps).toContain(C.AdminLibrary);
    expect(new Set(caps).size).toBe(caps.length);
  });
});
