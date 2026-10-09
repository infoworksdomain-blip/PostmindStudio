// @vitest-environment jsdom
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { choiceFromParams, PlanPicker } from './plan-picker';
import { pricingView, stripePrices } from './test-fixtures';
import type { PlanChoice, PricingView } from './types';

// 26.1 — the plan picker: Starter, Growth, Pro (cheapest first, Pro last), Growth marked "Most
// popular", weekly / monthly / yearly with the prices, HD videos, businesses and seats of each,
// a radio group the keyboard can drive, and a callback with { plan, interval }.

function Harness({
  pricing = pricingView(),
  initial = { plan: 'growth', interval: 'month' },
  onChange,
}: {
  pricing?: PricingView;
  initial?: PlanChoice;
  onChange?: (next: PlanChoice) => void;
}) {
  const [value, setValue] = useState<PlanChoice>(initial);
  return (
    <PlanPicker
      value={value}
      pricing={pricing}
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
    />
  );
}

function renderPicker(props: Parameters<typeof Harness>[0] = {}) {
  return render(<Harness {...props} />);
}

const plans = () => within(screen.getByRole('radiogroup', { name: 'Plan' })).getAllByRole('radio');

describe('PlanPicker (26.1)', () => {
  it('shows Starter, Growth and Pro in that order, Growth marked most popular', () => {
    renderPicker();
    expect(plans()).toHaveLength(3);
    expect(
      plans().map((p) => within(p).getAllByText(/^(Starter|Growth|Pro)$/)[0]!.textContent),
    ).toEqual(['Starter', 'Growth', 'Pro']);
    expect(within(screen.getByTestId('plan-option-growth')).getByText('Most popular')).toBeTruthy();
    expect(
      within(screen.getByTestId('plan-option-starter')).queryByText('Most popular'),
    ).toBeNull();
    expect(within(screen.getByTestId('plan-option-pro')).queryByText('Most popular')).toBeNull();
    expect(screen.getByRole('radio', { name: 'Growth' })).toHaveAttribute('aria-checked', 'true');
  });

  it('shows each plan’s monthly price, HD videos, quick posts, businesses, seats and platforms', () => {
    renderPicker();
    const pro = screen.getByTestId('plan-option-pro');
    expect(within(pro).getByText('£149.00 a month')).toBeTruthy();
    expect(within(pro).getByText('excl. VAT')).toBeTruthy();
    expect(within(pro).getByText('45 HD videos a month')).toBeTruthy();
    expect(within(pro).getByText(/Or up to 180 quick posts/)).toBeTruthy();
    expect(within(pro).getByText('3 businesses')).toBeTruthy();
    expect(within(pro).getByText('10 seats')).toBeTruthy();
    expect(within(pro).getByText('Posts to every platform')).toBeTruthy();
    const starter = screen.getByTestId('plan-option-starter');
    expect(within(starter).getByText('£29.00 a month')).toBeTruthy();
    expect(within(starter).getByText('8 HD videos a month')).toBeTruthy();
    expect(within(starter).getByText('1 business')).toBeTruthy();
    expect(within(starter).getByText('1 seat')).toBeTruthy();
    // Never a channel count or a per-video price.
    expect(document.body.textContent).not.toMatch(/channel|per video/i);
  });

  it('switching the interval changes the prices and the video counts', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPicker({ onChange });
    await user.click(screen.getByRole('radio', { name: 'Weekly' }));
    expect(onChange).toHaveBeenLastCalledWith({ plan: 'growth', interval: 'week' });
    const growth = screen.getByTestId('plan-option-growth');
    expect(within(growth).getByText('£22.50 a week')).toBeTruthy();
    expect(within(growth).getByText('5 HD videos a week')).toBeTruthy();
    expect(screen.getByText(/Weekly costs more than monthly/)).toBeTruthy();

    await user.click(screen.getByRole('radio', { name: 'Yearly' }));
    expect(onChange).toHaveBeenLastCalledWith({ plan: 'growth', interval: 'year' });
    expect(within(growth).getByText('£690.00 a year')).toBeTruthy();
    // Yearly releases the monthly allowance each calendar month.
    expect(within(growth).getByText('20 HD videos a month')).toBeTruthy();
    expect(within(growth).getByText('2 months free: you save £138.00 a year')).toBeTruthy();
    expect(screen.getByText('Pay yearly and get 2 months free.')).toBeTruthy();
  });

  it('calls back with the chosen plan on click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPicker({ onChange, initial: { plan: 'starter', interval: 'year' } });
    await user.click(screen.getByRole('radio', { name: 'Pro' }));
    expect(onChange).toHaveBeenLastCalledWith({ plan: 'pro', interval: 'year' });
    expect(screen.getByRole('radio', { name: 'Pro' })).toHaveAttribute('aria-checked', 'true');
  });

  it('is a radio group the keyboard can drive (one tab stop, arrows select, Space selects)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPicker({ onChange });
    const [starter, growth, pro] = plans();
    expect(growth).toHaveAttribute('tabindex', '0');
    expect(starter).toHaveAttribute('tabindex', '-1');
    expect(pro).toHaveAttribute('tabindex', '-1');
    growth!.focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith({ plan: 'pro', interval: 'month' });
    expect(pro).toHaveFocus();
    await user.keyboard('{Home}');
    expect(onChange).toHaveBeenLastCalledWith({ plan: 'starter', interval: 'month' });
    expect(starter).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith({ plan: 'pro', interval: 'month' });
    starter!.focus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith({ plan: 'starter', interval: 'month' });
  });

  it('reads "Price unavailable" when Stripe has no price, never a made-up number', () => {
    renderPicker({
      pricing: pricingView(stripePrices().filter((p) => p.lookupKey !== 'studio_pro_monthly')),
    });
    expect(
      within(screen.getByTestId('plan-option-pro')).getByText('Price unavailable'),
    ).toBeTruthy();
  });

  it('disabled: nothing can be chosen', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PlanPicker
        value={{ plan: 'growth', interval: 'month' }}
        pricing={pricingView()}
        onChange={onChange}
        disabled
      />,
    );
    await user.click(screen.getByRole('radio', { name: 'Pro' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('choiceFromParams', () => {
  const fallback: PlanChoice = { plan: 'growth', interval: 'month' };
  it('reads ?plan=&interval= and ignores anything else', () => {
    expect(choiceFromParams(new URLSearchParams('plan=pro&interval=week'), fallback)).toEqual({
      plan: 'pro',
      interval: 'week',
    });
    expect(choiceFromParams(new URLSearchParams('plan=enterprise&interval=day'), fallback)).toEqual(
      fallback,
    );
    expect(choiceFromParams(null, fallback)).toEqual(fallback);
  });
});
