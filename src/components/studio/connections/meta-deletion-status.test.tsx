// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { MetaDeletionStatus } from './meta-deletion-status';

// Phase 18 §2.10 — the Meta data-deletion status page body.

const status = { requestedAt: new Date(Date.UTC(2026, 9, 1, 12, 0)), connectionsDeleted: 2 };

describe('MetaDeletionStatus', () => {
  it('shows a completed request with its count and code', () => {
    render(<MetaDeletionStatus code="abc123" status={status} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Your data deletion request',
    );
    expect(screen.getByText('Status: completed')).toBeInTheDocument();
    expect(
      screen.getByText('2 Facebook or Instagram connections were deleted.'),
    ).toBeInTheDocument();
    expect(screen.getByText('abc123')).toBeInTheDocument();
  });

  it('says so when the code is unknown', () => {
    render(<MetaDeletionStatus code="nope" status={null} />);
    expect(screen.getByRole('alert')).toHaveTextContent('could not find a deletion request');
  });

  it.each([
    ['ar', 'الحالة: مكتمل'],
    ['zh-Hans', '状态：已完成'],
  ] as const)('renders in %s', (locale, text) => {
    render(withLocale(locale, <MetaDeletionStatus code="abc" status={status} />));
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});
