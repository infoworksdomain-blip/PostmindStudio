// @vitest-environment jsdom
import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntlTestProvider } from '../../../test/i18n-wrapper';
import { ThemeToggle } from './app-shell';

// 20.10 — a visitor who picked the dark theme got React error #418 (hydration mismatch) on every
// page: the server rendered "Use dark theme" and the browser's first render "Use light theme".

const theme = vi.hoisted(() => ({ resolvedTheme: 'dark' as string | undefined }));
vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: theme.resolvedTheme, setTheme: vi.fn() }),
}));

afterEach(() => {
  document.body.innerHTML = '';
});

function ui() {
  return (
    <IntlTestProvider syncDocument={false}>
      <ThemeToggle />
    </IntlTestProvider>
  );
}

describe('ThemeToggle', () => {
  it('hydrates without a mismatch for a dark-theme visitor, then shows the light switch', async () => {
    // The server has no saved theme.
    theme.resolvedTheme = undefined;
    const html = renderToString(ui());
    expect(html).toContain('Use dark theme');

    // The browser knows the saved theme (dark) from the first render on.
    theme.resolvedTheme = 'dark';
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.append(container);
    const recoverable = vi.fn();
    await act(async () => {
      hydrateRoot(container, ui(), { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(container.querySelector('button')).toHaveAttribute('aria-label', 'Use light theme');
  });
});
