import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../../src/app/api/studio/organisations/route';
import { organisationSlug } from '../../src/lib/auth/organisations';
import {
  setStandaloneAuthApi,
  type SignedInSession,
  type StandaloneAuthApi,
} from '../../src/lib/auth/session-route';

// Phase 18 Track A: POST /api/studio/organisations (onboarding step 1).

const ORIGIN = 'https://studio.test';
const session: SignedInSession = {
  session: { id: 's1', token: 't1', activeOrganizationId: null },
  user: { id: 'u1', email: 'a@example.com', name: 'A', emailVerified: true },
};

function api(overrides: Partial<StandaloneAuthApi> = {}): StandaloneAuthApi {
  return {
    getSession: vi.fn(async () => session),
    createOrganization: vi.fn(async (_h, input) => ({
      organisation: { id: 'org-new', name: input.name, slug: input.slug },
      setCookies: ['__Secure-studio.session_data=abc; Path=/; HttpOnly; Secure; SameSite=Lax'],
    })),
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = { origin: ORIGIN }) {
  return POST(
    new Request(`${ORIGIN}/api/studio/organisations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

afterEach(() => {
  setStandaloneAuthApi(undefined);
  vi.unstubAllEnvs();
});

describe('POST /api/studio/organisations', () => {
  it('creates the organisation for a user with none and forwards the session cookie', async () => {
    vi.stubEnv('APP_URL', ORIGIN);
    const fake = api();
    setStandaloneAuthApi(fake);
    const res = await post({ name: 'Leeds Sourdough', country: 'gb', defaultLocale: 'en-GB' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      ok: true,
      organisation: {
        id: 'org-new',
        name: 'Leeds Sourdough',
        slug: expect.stringMatching(/^leeds-sourdough-[0-9a-f]{6}$/),
      },
    });
    expect(res.headers.get('set-cookie')).toContain('studio.session_data');
    expect(fake.createOrganization).toHaveBeenCalledWith(
      expect.any(Headers),
      expect.objectContaining({ country: 'GB', defaultLocale: 'en-GB' }),
    );
  });

  it('401 when signed out', async () => {
    vi.stubEnv('APP_URL', ORIGIN);
    setStandaloneAuthApi(api({ getSession: vi.fn(async () => null) }));
    const res = await post({ name: 'X', country: 'GB', defaultLocale: 'en-GB' });
    expect(res.status).toBe(401);
  });

  it('403 for a cross-site request (CSRF)', async () => {
    vi.stubEnv('APP_URL', ORIGIN);
    const fake = api();
    setStandaloneAuthApi(fake);
    const res = await post(
      { name: 'X', country: 'GB', defaultLocale: 'en-GB' },
      {
        origin: 'https://evil.example',
      },
    );
    expect(res.status).toBe(403);
    expect(fake.createOrganization).not.toHaveBeenCalled();
  });

  it('400 on invalid input', async () => {
    vi.stubEnv('APP_URL', ORIGIN);
    setStandaloneAuthApi(api());
    for (const body of [
      { name: '', country: 'GB', defaultLocale: 'en-GB' },
      { name: 'X', country: 'GBR', defaultLocale: 'en-GB' },
      { name: 'X', country: 'GB', defaultLocale: 'klingon' },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
  });

  it('404 in core mode', async () => {
    vi.stubEnv('STUDIO_MODE', 'core');
    setStandaloneAuthApi(api());
    expect((await post({ name: 'X', country: 'GB', defaultLocale: 'en-GB' })).status).toBe(404);
  });
});

describe('organisationSlug', () => {
  it('keeps ASCII letters and digits and adds a random suffix', () => {
    expect(organisationSlug('Café Olé & Co.', () => 'abc123')).toBe('cafe-ole-co-abc123');
    expect(organisationSlug('商店', () => 'abc123')).toBe('org-abc123');
  });
});
