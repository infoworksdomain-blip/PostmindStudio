// @vitest-environment jsdom
import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useHydrated } from './use-hydrated';

function Probe() {
  return <p>{useHydrated() ? 'browser' : 'server'}</p>;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useHydrated', () => {
  it('is false in the server render', () => {
    expect(renderToString(<Probe />)).toContain('server');
  });

  it('is false while hydrating (no mismatch) and true right after', async () => {
    const container = document.createElement('div');
    container.innerHTML = renderToString(<Probe />);
    document.body.append(container);
    const recoverable = vi.fn();
    await act(async () => {
      hydrateRoot(container, <Probe />, { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(container.textContent).toBe('browser');
  });

  it('is true from the first render of a client-only mount', () => {
    render(<Probe />);
    expect(screen.getByText('browser')).toBeInTheDocument();
  });
});
