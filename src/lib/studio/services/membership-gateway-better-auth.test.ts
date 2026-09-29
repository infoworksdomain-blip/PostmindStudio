import { APIError } from 'better-auth/api';
import { describe, expect, it, vi } from 'vitest';
import { RateLimitError } from '../../errors';
import {
  createBetterAuthMembershipGateway,
  mapOrganisationError,
  type OrganisationAuthApi,
} from './membership-gateway-better-auth';

// Phase 18 §2.4: member and invitation writes go to Better Auth's organization API with the
// caller's headers; its errors become Studio errors the UI understands.

function fakeApi(over: Partial<OrganisationAuthApi> = {}): OrganisationAuthApi {
  return {
    createInvitation: vi.fn(async () => ({ id: 'inv_1' })),
    cancelInvitation: vi.fn(async () => ({})),
    updateMemberRole: vi.fn(async () => ({})),
    removeMember: vi.fn(async () => ({})),
    ...over,
  };
}

const headers = new Headers({ cookie: 'studio.session_token=x' });

describe('Better Auth membership gateway', () => {
  it('passes the request headers and the plugin body shapes', async () => {
    const api = fakeApi();
    const gateway = createBetterAuthMembershipGateway(async () => api);
    await expect(
      gateway.createInvitation(headers, {
        organisationId: 'o1',
        email: 'a@b.test',
        role: 'viewer',
      }),
    ).resolves.toEqual({ id: 'inv_1' });
    await gateway.createInvitation(headers, {
      organisationId: 'o1',
      email: 'a@b.test',
      role: 'viewer',
      resend: true,
    });
    await gateway.cancelInvitation(headers, { invitationId: 'inv_1' });
    await gateway.updateMemberRole(headers, {
      organisationId: 'o1',
      memberId: 'm1',
      role: 'admin',
    });
    await gateway.removeMember(headers, { organisationId: 'o1', memberId: 'm1' });
    expect(api.createInvitation).toHaveBeenNthCalledWith(1, {
      headers,
      body: { email: 'a@b.test', role: 'viewer', organizationId: 'o1' },
    });
    expect(api.createInvitation).toHaveBeenNthCalledWith(2, {
      headers,
      body: { email: 'a@b.test', role: 'viewer', organizationId: 'o1', resend: true },
    });
    expect(api.cancelInvitation).toHaveBeenCalledWith({ headers, body: { invitationId: 'inv_1' } });
    expect(api.updateMemberRole).toHaveBeenCalledWith({
      headers,
      body: { memberId: 'm1', role: 'admin', organizationId: 'o1' },
    });
    expect(api.removeMember).toHaveBeenCalledWith({
      headers,
      body: { memberIdOrEmail: 'm1', organizationId: 'o1' },
    });
  });

  it('an invitation without an id is an error', async () => {
    const gateway = createBetterAuthMembershipGateway(async () =>
      fakeApi({ createInvitation: vi.fn(async () => null) }),
    );
    await expect(
      gateway.createInvitation(headers, { organisationId: 'o', email: 'a@b.test', role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('maps Better Auth errors to Studio errors', async () => {
    const err = (status: 'FORBIDDEN' | 'BAD_REQUEST' | 'NOT_FOUND', code: string) =>
      new APIError(status, { code, message: code });
    const cases: Array<[APIError, string, string | undefined]> = [
      [err('FORBIDDEN', 'ORGANIZATION_MEMBERSHIP_LIMIT_REACHED'), 'quota_exceeded', 'seat_limit'],
      [
        err('BAD_REQUEST', 'YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER'),
        'conflict',
        'last_owner',
      ],
      [
        err('BAD_REQUEST', 'USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION'),
        'conflict',
        'already_member',
      ],
      [err('BAD_REQUEST', 'MEMBER_NOT_FOUND'), 'not_found', undefined],
      [err('FORBIDDEN', 'YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS'), 'forbidden', undefined],
      [err('BAD_REQUEST', 'SOMETHING_ELSE'), 'validation_error', undefined],
    ];
    for (const [input, code, reason] of cases) {
      try {
        mapOrganisationError(input);
      } catch (mapped) {
        expect(mapped).toMatchObject({ code });
        if (reason)
          expect((mapped as { details?: { reason?: string } }).details?.reason).toBe(reason);
      }
    }
    const limited = new APIError(
      'TOO_MANY_REQUESTS',
      { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' },
      { 'X-Retry-After': '1200' },
    );
    expect(() => mapOrganisationError(limited)).toThrow(RateLimitError);
    try {
      mapOrganisationError(limited);
    } catch (mapped) {
      expect(mapped).toMatchObject({
        code: 'rate_limited',
        status: 429,
        retryAfterSec: 1200,
        details: { reason: 'invite_rate_limited' },
      });
    }
    const plain = new Error('boom');
    expect(() => mapOrganisationError(plain)).toThrow(plain);
  });
});
