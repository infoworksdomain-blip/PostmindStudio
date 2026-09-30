// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../test/i18n-wrapper';
import RootError from '@/app/error';
import StudioError from '@/app/(studio)/error';
import { NotFoundView, PageErrorView } from './page-error';

describe('NotFoundView', () => {
  it('explains the missing page and links to projects and home', () => {
    render(<NotFoundView />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'We couldn’t find that page' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to projects' })).toHaveAttribute(
      'href',
      '/projects',
    );
    expect(screen.getByRole('link', { name: 'Go to the home page' })).toHaveAttribute('href', '/');
  });

  it('is translated (ar)', () => {
    render(withLocale('ar', <NotFoundView />));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('لم نعثر على هذه الصفحة');
  });
});

describe('PageErrorView', () => {
  it('shows a friendly message, a retry and the error reference', async () => {
    const reset = vi.fn();
    render(
      <PageErrorView
        error={Object.assign(new Error('boom'), { digest: 'abc123' })}
        reset={reset}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('This page hit a problem');
    // The raw error text is not shown to the user.
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
    expect(screen.getByText('Reference: abc123')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it('omits the reference when there is no digest', () => {
    render(<PageErrorView error={new Error('boom')} reset={() => undefined} />);
    expect(screen.queryByText(/Reference:/)).not.toBeInTheDocument();
  });

  it('is what the root and Studio error boundaries render', () => {
    const { unmount } = render(<RootError error={new Error('x')} reset={() => undefined} />);
    expect(screen.getByRole('alert')).toHaveTextContent('This page hit a problem');
    unmount();
    render(<StudioError error={new Error('x')} reset={() => undefined} />);
    expect(screen.getByRole('alert')).toHaveTextContent('This page hit a problem');
  });
});
