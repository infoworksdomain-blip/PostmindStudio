// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleButton } from './google-button';

// "Continue with Google" keeps its spinner only while the page is really leaving. The demo's
// hardNavigate shim stays on the page (a notice instead of Google) and answers false.

const navigation = vi.hoisted(() => ({ hardNavigate: vi.fn<(url: string) => boolean>() }));
vi.mock('@/lib/client/navigate', () => ({
  hardNavigate: navigation.hardNavigate,
  hardReload: vi.fn(),
}));

const GOOGLE_URL = 'https://accounts.google.com/o/oauth2/v2/auth?state=s';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ url: GOOGLE_URL, redirect: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
  navigation.hardNavigate.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

describe('GoogleButton', () => {
  it('stays busy while the page leaves for Google', async () => {
    navigation.hardNavigate.mockReturnValue(true);
    render(<GoogleButton next="/projects" />);
    const button = screen.getByRole('button', { name: 'Continue with Google' });
    await userEvent.click(button);
    await waitFor(() => expect(navigation.hardNavigate).toHaveBeenCalledWith(GOOGLE_URL));
    expect(button).toBeDisabled();
  });

  it('stops the spinner when navigation is shimmed and the page stays', async () => {
    navigation.hardNavigate.mockReturnValue(false);
    render(<GoogleButton next="/projects" />);
    const button = screen.getByRole('button', { name: 'Continue with Google' });
    await userEvent.click(button);
    await waitFor(() => expect(navigation.hardNavigate).toHaveBeenCalledWith(GOOGLE_URL));
    await waitFor(() => expect(button).toBeEnabled());
  });
});
