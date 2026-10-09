// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { renderWithSWR } from '../review/test-helpers';
import { describe, expect, it, vi } from 'vitest';
import type { CreateState } from './body';
import { BudgetField } from './create-options';
import { MoreOptions, type MoreOptionsProps } from './create-more-options';

const base: CreateState = {
  brief: 'A video',
  source: 'BRIEF',
  platforms: ['tiktok'],
  length: 'short',
  brandKitId: null,
  templateId: null,
  targetAudience: '',
  callToAction: '',
  budgetPounds: '',
  reviewPolicy: '',
  projectTemplate: null,
  autoPublish: false,
  autoPublishAccounts: {},
};

function renderOptions(over: Partial<CreateState>) {
  render(<BudgetField state={{ ...base, ...over }} onChange={vi.fn()} />);
  return screen.getByLabelText('Budget cap (£)');
}

function moreOptions(over: Partial<MoreOptionsProps> = {}) {
  const props: MoreOptionsProps = {
    state: base,
    onChange: vi.fn(),
    open: true,
    onToggle: vi.fn(),
    view: { templated: false, canUseTemplate: false, fixedLength: false },
    businessId: null,
    kits: [],
    templates: { data: [], error: undefined, retry: vi.fn(), choose: vi.fn() },
    planTier: 'STANDARD',
    workflows: [],
    canSchedule: true,
    showCosts: false,
    ...over,
  };
  return renderWithSWR(<MoreOptions {...props} />);
}

describe('More options (25.7)', () => {
  it('has no budget field, hint or amount unless the viewer is platform staff', () => {
    moreOptions();
    expect(screen.getByLabelText('Approval')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Budget/)).not.toBeInTheDocument();
    expect(screen.queryByText(/£/)).not.toBeInTheDocument();
  });

  it('groups every option under one disclosure, by what it decides', () => {
    moreOptions({ showCosts: true });
    const toggle = screen.getByRole('button', { name: 'More options' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // 26.2: the Button primitive (ghost), like the planner's toggle; not a hand-built button.
    expect(toggle).toHaveAttribute('data-variant', 'ghost');
    expect(toggle).toHaveClass('rounded-control');
    for (const name of [
      'Platforms and length',
      'Brand and language',
      'Audience and call to action',
      'Approval and schedule',
      'Quality',
    ])
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    expect(screen.getByLabelText('Budget cap (£)')).toBeInTheDocument();
    expect(screen.getByLabelText('Quality tier')).toBeInTheDocument();
  });

  it('shows only what a carousel uses, and nothing while closed', () => {
    const { unmount } = moreOptions({ state: { ...base, source: 'CAROUSEL' } });
    expect(
      screen.queryByRole('heading', { name: 'Approval and schedule' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'TikTok' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Brand kit')).toBeInTheDocument();
    unmount();
    moreOptions({ open: false });
    expect(screen.queryByLabelText('Approval')).not.toBeInTheDocument();
  });

  it('drops the length choice for fixed-length formats and templates', () => {
    moreOptions({ view: { templated: false, canUseTemplate: false, fixedLength: true } });
    expect(screen.queryByRole('radio', { name: 'Long' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'TikTok' })).toBeInTheDocument();
  });
});

describe('BudgetField default for staff (operator decision 2)', () => {
  it('shows the short-form default for short videos, with how the pause and raise work', () => {
    expect(renderOptions({})).toHaveAttribute('placeholder', 'Default £3.50');
    expect(screen.getByText(/Generation pauses at 90% of this/)).toHaveTextContent(
      'you can raise it on the project page. Blank = £3.50 for short videos, £30.00 for long-form',
    );
  });

  it('shows the long-form default when a YouTube long video is selected', () => {
    expect(renderOptions({ platforms: ['tiktok', 'youtube'], length: 'long' })).toHaveAttribute(
      'placeholder',
      'Default £30.00',
    );
  });

  it('stays short-form for long TikToks (90 s)', () => {
    expect(renderOptions({ length: 'long' })).toHaveAttribute('placeholder', 'Default £3.50');
  });

  it('names both defaults for a project template (its formats are applied server-side)', () => {
    expect(
      renderOptions({ projectTemplate: { id: 't1', name: 'Intro', platforms: ['tiktok'] } }),
    ).toHaveAttribute('placeholder', 'Default £3.50 / £30.00');
  });
});
