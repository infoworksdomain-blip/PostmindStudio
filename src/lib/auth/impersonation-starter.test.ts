import { APIError } from 'better-auth/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, NotFoundError } from '../errors';
import { getImpersonationStarter, setImpersonationStarter } from '../studio/admin/impersonation';
import {
  createBetterAuthImpersonationStarter,
  IMPERSONATION_LANDING,
  type ImpersonateUserApi,
} from './impersonation-starter';

// Phase 18 §2.5: Track A's Better Auth impersonateUser behind Track E's ImpersonationStarter.

const on = { STUDIO_IMPERSONATION_ENABLED: 'true' };

function fakeApi(impl?: ImpersonateUserApi['impersonateUser']) {
  const impersonateUser = vi.fn(
    impl ??
      (async () => {
        const headers = new Headers();
        headers.append('set-cookie', 'studio.session_token=imp; Path=/; HttpOnly');
        headers.append('set-cookie', 'studio.admin_session=adm; Path=/; HttpOnly');
        return { headers, response: { session: {}, user: {} } };
      }),
  );
  return { impersonateUser };
}

afterEach(() => setImpersonationStarter(undefined));

describe('Better Auth impersonation starter', () => {
  it('creates the session with the caller headers and forwards its cookies', async () => {
    const api = fakeApi();
    const headers = new Headers({ cookie: 'studio.session_token=staff' });
    setImpersonationStarter(createBetterAuthImpersonationStarter(api, on));

    const result = await getImpersonationStarter().start(headers, { userId: 'u1' });

    expect(api.impersonateUser).toHaveBeenCalledWith({
      headers,
      body: { userId: 'u1' },
      returnHeaders: true,
    });
    expect(result.redirectTo).toBe(IMPERSONATION_LANDING);
    expect(result.setCookies).toHaveLength(2);
  });

  it('refuses while STUDIO_IMPERSONATION_ENABLED is off (the default), without calling Better Auth', async () => {
    const api = fakeApi();
    const starter = createBetterAuthImpersonationStarter(api, {});
    await expect(starter.start(new Headers(), { userId: 'u1' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(api.impersonateUser).not.toHaveBeenCalled();
  });

  it('maps Better Auth refusals to Studio errors', async () => {
    const forbidden = createBetterAuthImpersonationStarter(
      fakeApi(async () => {
        throw new APIError('FORBIDDEN', { message: 'You cannot impersonate admins' });
      }),
      on,
    );
    await expect(forbidden.start(new Headers(), { userId: 'u1' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const missing = createBetterAuthImpersonationStarter(
      fakeApi(async () => {
        throw new APIError('NOT_FOUND', { message: 'User not found' });
      }),
      on,
    );
    await expect(missing.start(new Headers(), { userId: 'u1' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('without a registered starter (core mode, flag off) a start answers 501', async () => {
    await expect(getImpersonationStarter().start(new Headers(), { userId: 'u1' })).rejects.toThrow(
      /Better Auth/,
    );
  });
});
