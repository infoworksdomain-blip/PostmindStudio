// In-browser stand-in for Better Auth's /api/auth/* in the demo build (Track A's sign-up, sign-in,
// two-step, invite and account screens call it directly). Nothing is created: sign-up and the
// resend link answer as the server would (200, then the "check your email" screen); any email and
// password sign in to the sample organisation (the sample user's own address asks for the second
// step, where any 6-digit code or a backup code works); sign-out signs out of the demo
// (./session-state.ts). Google
// answers an authorisation URL the demo does not follow. Anything else is refused with a code the
// screens map to their generic message.
import { setSignedIn } from './session-state';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// The signed-in sample user (Amara, owner of Leeds Sourdough) for /account/profile and
// /account/security. No token reaches the page: the id and token are placeholders.
const SESSION = {
  session: {
    id: 'sess-demo-current',
    token: 'demo',
    activeOrganizationId: 'org-leeds-sourdough',
    createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  },
  user: {
    id: 'user-amara',
    email: 'amara@leedssourdough.example',
    name: 'Amara Okafor',
    emailVerified: true,
    twoFactorEnabled: true,
    locale: 'en-GB',
  },
};

const GOOGLE_URL =
  'https://accounts.google.com/o/oauth2/v2/auth?client_id=demo&response_type=code&scope=openid%20email%20profile';

const signedInWith = (body: unknown) => {
  setSignedIn(true);
  return json(200, body);
};

const ANSWERS: Record<string, (body: unknown) => Response> = {
  'POST /sign-up/email': () => json(200, { token: null, user: null }),
  'POST /send-verification-email': () => json(200, { status: true }),
  // Any email and password sign in to the sample organisation. The sample user's own address has
  // two-step verification on, so it goes on to /two-factor (any 6-digit code).
  'POST /sign-in/email': (body) =>
    String((body as { email?: unknown } | null)?.email ?? '')
      .trim()
      .toLowerCase() === SESSION.user.email
      ? json(200, { twoFactorRedirect: true })
      : signedInWith({ redirect: false, token: null, user: SESSION.user }),
  'POST /two-factor/verify-totp': (body) =>
    /^\d{6}$/.test(String((body as { code?: unknown } | null)?.code ?? ''))
      ? signedInWith({ token: null, user: SESSION.user })
      : json(401, { code: 'INVALID_CODE', message: 'Invalid code' }),
  'POST /two-factor/verify-backup-code': () => signedInWith({ token: null, user: SESSION.user }),
  'POST /sign-in/social': () => json(200, { url: GOOGLE_URL, redirect: true }),
  'POST /link-social': () => json(200, { url: GOOGLE_URL, redirect: true }),
  'POST /sign-out': () => {
    setSignedIn(false, { byUser: true });
    return json(200, { success: true });
  },
  'GET /get-session': () => json(200, SESSION),
  'GET /list-accounts': () => json(200, [{ providerId: 'credential' }]),
  'POST /update-user': () => json(200, { status: true }),
  'POST /organization/set-active': () => json(200, { ok: true }),
  'GET /organization/get-invitation': () =>
    json(200, {
      id: 'inv-demo',
      organizationName: 'Harrogate Coffee Co',
      role: 'publisher',
      inviterEmail: 'owner@harrogate-coffee.example',
      status: 'pending',
    }),
  'POST /organization/accept-invitation': () => json(200, { invitation: { id: 'inv-demo' } }),
};

function parseBody(init?: RequestInit): unknown {
  if (typeof init?.body !== 'string') return null;
  try {
    return JSON.parse(init.body);
  } catch {
    return null;
  }
}

export async function handleAuth(url: URL, init?: RequestInit): Promise<Response> {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const method = (init?.method ?? 'GET').toUpperCase();
  const path = url.pathname.replace(/^\/api\/auth/, '');
  const answer = ANSWERS[`${method} ${path}`];
  if (answer) return answer(parseBody(init));
  return json(403, { code: 'DEMO_ONLY', message: 'This sign-in step does not run in the demo.' });
}
