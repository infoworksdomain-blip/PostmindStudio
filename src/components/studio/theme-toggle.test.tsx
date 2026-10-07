// @vitest-environment jsdom
import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntlTestProvider } from '../../../test/i18n-wrapper';
import { ThemeToggle } from './app-shell';
import { ThemeSwitcher } from './theme-switcher';

// 20.10 — a visitor who picked the dark theme got React error #418 (hydration mismatch) on every
// page: the server rendered "Use dark theme" and the browser's first render "Use light theme".
// 25.2 — the toggle became Light / Dark / System; the same rule holds for every control.

const theme = vi.hoisted(() => ({
  theme: 'dark' as string | undefined,
  setTheme: (() => undefined) as (value: string) => void,
}));
vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: theme.theme, setTheme: theme.setTheme }),
}));

afterEach(() => {
  document.body.innerHTML = '';
});

function wrap(node: React.ReactNode) {
  return <IntlTestProvider syncDocument={false}>{node}</IntlTestProvider>;
}

describe('ThemeToggle (top-bar appearance button)', () => {
  it('hydrates without a mismatch for a dark-theme visitor, then names the current choice', async () => {
    // The server has no saved theme.
    theme.theme = undefined;
    const html = renderToString(wrap(<ThemeToggle />));
    expect(html).toContain('aria-label="Appearance"');

    // The browser knows the saved theme (dark) from the first render on.
    theme.theme = 'dark';
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.append(container);
    const recoverable = vi.fn();
    await act(async () => {
      hydrateRoot(container, wrap(<ThemeToggle />), { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(container.querySelector('button')).toHaveAttribute('aria-label', 'Appearance: Dark');
  });
});

describe('ThemeSwitcher (segmented Light / Dark / System)', () => {
  it('hydrates without a mismatch, then checks the saved choice', async () => {
    theme.theme = undefined;
    const html = renderToString(wrap(<ThemeSwitcher />));
    theme.theme = 'system';
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.append(container);
    const recoverable = vi.fn();
    await act(async () => {
      hydrateRoot(container, wrap(<ThemeSwitcher />), { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
    const checked = container.querySelector<HTMLInputElement>('input:checked');
    expect(checked?.value).toBe('system');
  });

  it('is a labelled radio group whose options set the theme', async () => {
    const setTheme = vi.fn();
    theme.setTheme = setTheme;
    theme.theme = 'light';
    render(wrap(<ThemeSwitcher />));
    expect(screen.getByRole('group', { name: 'Appearance' })).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual(['light', 'dark', 'system']);
    expect(screen.getByRole('radio', { name: 'Light' })).toBeChecked();

    await userEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(setTheme).toHaveBeenCalledWith('dark');
    await userEvent.click(screen.getByRole('radio', { name: 'System' }));
    expect(setTheme).toHaveBeenCalledWith('system');
  });
});
