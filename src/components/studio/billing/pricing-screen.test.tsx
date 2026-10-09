// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PricingScreen, signUpHref } from './pricing-screen';
import { pricingView, stripePrices } from './test-fixtures';

// 26.1 /pricing: three plans, Starter, Growth (most popular) and Pro (last), each posting to every
// platform. A weekly / monthly / yearly switch shows each plan's price for the period, its HD
// videos, businesses and seats and the yearly saving; the packs and the FAQ follow; "Start free
// trial" signs up and lands on Your plan with the same choice. No channels, no old tiers, no cost
// or budget figures.

describe('PricingScreen (26.1)', () => {
  it('shows the three plans (Growth chosen and most popular), the trial and the CTA', () => {
    const { container } = render(<PricingScreen pricing={pricingView()} />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Three plans. Every platform.' }),
    ).toBeInTheDocument();
    const group = screen.getByRole('radiogroup', { name: 'Plan' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('data-testid'))).toEqual([
      'plan-option-starter',
      'plan-option-growth',
      'plan-option-pro',
    ]);
    expect(screen.getByRole('radio', { name: 'Growth' })).toHaveAttribute('aria-checked', 'true');
    expect(within(screen.getByTestId('plan-option-growth')).getByText('Most popular')).toBeTruthy();
    expect(screen.getByText('£29.00 a month')).toBeInTheDocument();
    expect(screen.getByText('£69.00 a month')).toBeInTheDocument();
    expect(screen.getByText('£149.00 a month')).toBeInTheDocument();
    expect(screen.getByText(/Try it free for 7 days with 2 videos/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Start free trial/ })).toHaveAttribute(
      'href',
      signUpHref({ plan: 'growth', interval: 'month' }),
    );
    // No channels, old tiers, long videos or costs.
    expect(container.textContent).not.toMatch(
      /channel|Basic|Plus|Enterprise|long video|budget|spend/i,
    );
  });

  it('the period switch and the plan choice change the prices and the sign-up link', async () => {
    const user = userEvent.setup();
    render(<PricingScreen pricing={pricingView()} />);
    await user.click(screen.getByRole('radio', { name: 'Weekly' }));
    expect(screen.getByText('£9.50 a week')).toBeInTheDocument();
    expect(screen.getByText('2 HD videos a week')).toBeInTheDocument();
    expect(screen.getByText(/Weekly costs more than monthly/)).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Yearly' }));
    expect(screen.getByText('£1,490.00 a year')).toBeInTheDocument();
    expect(screen.getByText('2 months free: you save £298.00 a year')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Pro' }));
    expect(screen.getByRole('link', { name: /Start free trial/ })).toHaveAttribute(
      'href',
      '/sign-up?next=%2Fsettings%2Fbilling%3Fplan%3Dpro%26interval%3Dyear',
    );
  });

  it('lists the HD video packs and answers the FAQ with live prices and true facts', async () => {
    const user = userEvent.setup();
    render(<PricingScreen pricing={pricingView()} />);
    const packs = screen.getByRole('region', { name: 'Need more videos?' });
    expect(within(packs).getByText('5 HD videos')).toBeInTheDocument();
    expect(within(packs).getByText('£17.00')).toBeInTheDocument();
    expect(within(packs).getByText('15 HD videos')).toBeInTheDocument();
    expect(within(packs).getByText('£45.00')).toBeInTheDocument();
    expect(within(packs).getAllByText('Use within 3 months, on any plan')).toHaveLength(2);
    expect(
      screen.getByText(/Starter is £29\.00 a month\. Weekly is £9\.50 a week/),
    ).toBeInTheDocument();
    await user.click(screen.getByText('Which platforms can I post to?'));
    expect(
      screen.getByText(/All six, on every plan: TikTok, Instagram, YouTube, Facebook, LinkedIn/),
    ).toBeInTheDocument();
    expect(screen.queryByText('What is a channel?')).toBeNull();
  });

  it('shows "Price unavailable" rather than a made-up number when Stripe is unreachable', () => {
    render(<PricingScreen pricing={pricingView(null)} />);
    expect(screen.getByText(/Prices can’t be shown right now/)).toBeInTheDocument();
    expect(screen.getAllByText('Price unavailable').length).toBeGreaterThan(0);
  });

  it('a price changed in Stripe shows with no code change', () => {
    render(<PricingScreen pricing={pricingView(stripePrices({ studio_growth_monthly: 7_500 }))} />);
    expect(screen.getByText('£75.00 a month')).toBeInTheDocument();
  });
});

describe('PricingScreen: quick posts count ¼ (23.3)', () => {
  it('says each plan’s videos can be up to 4× as many quick posts, in the cards and the FAQ', async () => {
    const user = userEvent.setup();
    render(<PricingScreen pricing={pricingView()} />);
    // Starter 8, Growth 20, Pro 45 videos a month.
    for (const quick of [32, 80, 180])
      expect(
        screen.getByText(
          `Or up to ${quick} quick posts: carousels, slideshows and text videos count as ¼`,
        ),
      ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Quick posts count as ¼ of a video: carousels, slideshows, wall of text and hook + demo videos',
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByText('Do carousels and slideshows count as a whole video?'));
    expect(
      screen.getByText(/so Starter’s 8 videos a month can be up to 32 quick posts/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Weekly' }));
    // Growth weekly: 5 videos = 20 quick posts.
    expect(
      within(screen.getByTestId('plan-option-growth')).getByText(
        'Or up to 20 quick posts: carousels, slideshows and text videos count as ¼',
      ),
    ).toBeInTheDocument();
  });
});
