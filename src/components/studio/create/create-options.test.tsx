// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CreateState } from './body';
import { AdvancedOptions } from './create-options';

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
  render(
    <AdvancedOptions
      state={{ ...base, ...over }}
      onChange={vi.fn()}
      open
      onToggle={vi.fn()}
      showCosts
    />,
  );
  return screen.getByLabelText('Budget cap (£)');
}

describe('AdvancedOptions budget for customers (operator decision 2026-10-04)', () => {
  it('has no budget field, hint or amount unless the viewer is platform staff', () => {
    render(<AdvancedOptions state={base} onChange={vi.fn()} open onToggle={vi.fn()} />);
    expect(screen.getByLabelText('Approval')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Budget/)).not.toBeInTheDocument();
    expect(screen.queryByText(/£/)).not.toBeInTheDocument();
  });
});

describe('AdvancedOptions budget default for staff (operator decision 2)', () => {
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
