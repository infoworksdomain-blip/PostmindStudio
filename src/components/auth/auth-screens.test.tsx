// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../test/i18n-wrapper';
import { ForgotPasswordForm } from './forgot-password-form';
import { passwordStrength } from './password-field';
import { ResetPasswordForm } from './reset-password-form';
import { SignInForm } from './sign-in-form';
import { SignUpForm } from './sign-up-form';
import { TwoFactorForm } from './two-factor-form';
import { InviteScreen } from './invite-screen';
import { SignUpClosed } from './sign-up-closed';
import { VerifyEmailScreen } from './verify-email-screen';

// Phase 18 Track A — the sign-in screens against a mocked /api/auth.

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn(), refresh: vi.fn() }),
}));

const assign = vi.fn();
let fetchMock: ReturnType<typeof vi.fn>;

function respond(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

beforeEach(() => {
  // Radix Checkbox measures itself; jsdom has no ResizeObserver.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(window, 'location', { value: { assign }, writable: true });
  nav.push.mockReset();
  assign.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

const signIn = () => <SignInForm next="/projects" googleEnabled={false} signupsEnabled />;

describe('sign-in', () => {
  it('signs in and goes to next', async () => {
    respond(200, { user: { id: 'u1' } });
    render(signIn());
    await userEvent.type(screen.getByLabelText('Email'), 'a@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/projects'));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/sign-in/email');
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'a@example.com',
      password: 'correct horse battery',
    });
  });

  it('shows one generic message for bad credentials, not the server text', async () => {
    respond(401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' });
    render(signIn());
    await userEvent.type(screen.getByLabelText('Email'), 'a@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong password 1');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That email and password don’t match an account.',
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it('moves to the 2FA step when the account has two-factor on', async () => {
    respond(200, { twoFactorRedirect: true, twoFactorMethods: ['totp'] });
    render(signIn());
    await userEvent.type(screen.getByLabelText('Email'), 'a@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/two-factor?next=%2Fprojects'));
  });

  it('sends an unverified user to the verify-email screen', async () => {
    respond(403, { code: 'EMAIL_NOT_VERIFIED' });
    render(signIn());
    await userEvent.type(screen.getByLabelText('Email'), 'a@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(nav.push).toHaveBeenCalledWith('/verify-email?email=a%40example.com&sent=1'),
    );
  });

  it('shows the rate-limit message on 429', async () => {
    respond(429, { message: 'Too many requests' });
    render(signIn());
    await userEvent.type(screen.getByLabelText('Email'), 'a@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts');
  });

  it('renders in Arabic (RTL) and Simplified Chinese', () => {
    const { unmount } = render(withLocale('ar', signIn()));
    expect(screen.getByRole('heading', { name: 'تسجيل الدخول' })).toBeInTheDocument();
    expect(document.documentElement.dir).toBe('rtl');
    unmount();
    render(withLocale('zh-Hans', signIn()));
    expect(screen.getByRole('heading', { name: '登录' })).toBeInTheDocument();
  });
});

describe('sign-up', () => {
  it('always moves on to "check your email" (no enumeration)', async () => {
    respond(200, { token: null, user: { id: 'x' } });
    render(<SignUpForm next="/welcome" googleEnabled={false} />);
    await userEvent.type(screen.getByLabelText('Your name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Work email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'a long enough passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() =>
      expect(nav.push).toHaveBeenCalledWith('/verify-email?email=ada%40example.com&sent=1'),
    );
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.callbackURL).toBe('/welcome');
  });

  it('keeps the submit disabled under 12 characters and explains a breached password', async () => {
    respond(400, { code: 'PASSWORD_COMPROMISED' });
    render(<SignUpForm next="/welcome" googleEnabled={false} />);
    await userEvent.type(screen.getByLabelText('Your name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Work email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'short');
    expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Password'), 'password12345');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('data breach');
  });
});

describe('forgot and reset password', () => {
  it('always answers the same, whatever the server says (except 429)', async () => {
    respond(500, { message: 'boom' });
    render(<ForgotPasswordForm />);
    await userEvent.type(screen.getByLabelText('Email'), 'a@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(/If an account uses that address/)).toBeInTheDocument();
  });

  it('shows the invalid-link state without a token', () => {
    render(<ResetPasswordForm error="INVALID_TOKEN" />);
    expect(screen.getByRole('heading', { name: 'That link didn’t work' })).toBeInTheDocument();
  });

  it('resets with the token', async () => {
    respond(200, { status: true });
    render(<ResetPasswordForm token="tok" />);
    await userEvent.type(screen.getByLabelText('New password'), 'a brand new passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await screen.findByText(/Your password has changed/)).toBeInTheDocument();
    expect(
      JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string),
    ).toEqual({
      token: 'tok',
      newPassword: 'a brand new passphrase',
    });
  });
});

describe('two-factor', () => {
  it('verifies a TOTP code, or switches to a backup code', async () => {
    respond(400, { code: 'INVALID_CODE' });
    respond(200, { token: 't' });
    render(<TwoFactorForm next="/projects" />);
    await userEvent.type(screen.getByLabelText('Authentication code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That code isn’t right');
    await userEvent.click(screen.getByRole('button', { name: 'Use a backup code instead' }));
    await userEvent.type(screen.getByLabelText('Backup code'), 'abcde-12345');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/projects'));
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/auth/two-factor/verify-backup-code');
  });
});

describe('25.6 states and field errors', () => {
  it('shows a breached password under the field, linked and focused', async () => {
    respond(400, { code: 'PASSWORD_COMPROMISED' });
    render(<SignUpForm next="/welcome" googleEnabled={false} />);
    await userEvent.type(screen.getByLabelText('Your name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Work email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'password12345');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    const message = await screen.findByRole('alert');
    const password = screen.getByLabelText('Password');
    expect(password).toHaveAttribute('aria-invalid', 'true');
    expect(password.getAttribute('aria-describedby')).toContain(message.id);
    await waitFor(() => expect(password).toHaveFocus());
  });

  it('labels the email and password fields for password managers', () => {
    render(signIn());
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByRole('link', { name: 'Forgot your password?' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });

  it('asks for the 2FA code in one numeric one-time-code field', () => {
    render(<TwoFactorForm next="/projects" />);
    const code = screen.getByLabelText('Authentication code');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
  });

  it('says what happens next once a reset link is sent, and offers another address', async () => {
    respond(200, { status: true });
    render(<ForgotPasswordForm />);
    await userEvent.type(screen.getByLabelText('Email'), 'a@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument();
    expect(screen.getByText(/choose a new password/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Use a different email' }));
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument();
  });

  it('makes a new link the next step for an expired verification link', () => {
    render(<VerifyEmailScreen error="TOKEN_EXPIRED" />);
    expect(screen.getByRole('heading', { name: 'That link didn’t work' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send a new link' })).toHaveAttribute(
      'data-variant',
      'default',
    );
  });

  it('explains an invitation that cannot be used, with the next step', async () => {
    respond(400, { code: 'INVITATION_NOT_FOUND' });
    render(<InviteScreen invitationId="inv_1" signedIn />);
    expect(
      await screen.findByRole('heading', { name: 'This invitation can’t be used' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Studio' })).toHaveAttribute('href', '/home');
  });

  it('keeps the closed sign-up screen calm, with sign-in as the way on', () => {
    render(<SignUpClosed />);
    expect(screen.getByRole('heading', { name: 'Invitation only' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');
  });
});

describe('passwordStrength', () => {
  it('scores length first', () => {
    expect(passwordStrength('short')).toBe(0);
    expect(passwordStrength('abcdefghijkl')).toBe(1);
    expect(passwordStrength('Abcdefghijkl1!mnopqrs')).toBe(4);
    expect(passwordStrength('aaaaaaaaaaaaaaaa')).toBe(1);
  });
});
