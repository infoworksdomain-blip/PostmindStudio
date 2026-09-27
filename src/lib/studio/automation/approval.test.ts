import { describe, expect, it } from 'vitest';
import { ForbiddenError } from '../../errors';
import {
  assertMayApprove,
  AUTO_APPROVE_ACTOR,
  AUTO_PUBLISH_ACTOR,
  isSystemActor,
  requiredRoleFor,
} from './approval';

const approver = (role: string, organisationId = 'org-1') => ({
  organisationId: 'org-1',
  memberships: [{ organisationId, role }],
});

describe('assertMayApprove', () => {
  it('lets anyone with the approve capability approve ordinary projects', () => {
    expect(() =>
      assertMayApprove(approver('member'), { reviewPolicy: 'REQUIRE_APPROVAL' }),
    ).not.toThrow();
    expect(() =>
      assertMayApprove(approver('member'), { reviewPolicy: 'AUTO_APPROVE' }),
    ).not.toThrow();
  });

  it.each(['owner', 'admin', 'Admin', ' OWNER '])(
    'REQUIRE_APPROVAL_FROM_ROLE accepts role %s',
    (role) => {
      expect(() =>
        assertMayApprove(approver(role), { reviewPolicy: 'REQUIRE_APPROVAL_FROM_ROLE' }),
      ).not.toThrow();
    },
  );

  it('REQUIRE_APPROVAL_FROM_ROLE refuses other roles', () => {
    expect(() =>
      assertMayApprove(approver('member'), { reviewPolicy: 'REQUIRE_APPROVAL_FROM_ROLE' }),
    ).toThrow(ForbiddenError);
  });

  it('ignores an owner membership in a different organisation', () => {
    expect(() =>
      assertMayApprove(approver('owner', 'org-2'), {
        reviewPolicy: 'REQUIRE_APPROVAL_FROM_ROLE',
      }),
    ).toThrow(ForbiddenError);
  });
});

describe('actors and roles', () => {
  it('recognises system actors', () => {
    expect(isSystemActor(AUTO_APPROVE_ACTOR)).toBe(true);
    expect(isSystemActor(AUTO_PUBLISH_ACTOR)).toBe(true);
    expect(isSystemActor('user-1')).toBe(false);
    expect(isSystemActor(null)).toBe(false);
  });

  it('records the required role on the approval row', () => {
    expect(requiredRoleFor('REQUIRE_APPROVAL_FROM_ROLE')).toBe('owner|admin');
    expect(requiredRoleFor('REQUIRE_APPROVAL')).toBe('reviewer');
  });
});
