// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PricingScreen, signUpHref } from './pricing-screen';
import { pricingView, stripePrices } from './test-fixtures';

// 21.5 /pricing: one per-channel plan. A channel stepper (1–6) and a weekly / monthly / yearly
// switch show the total for the period, the videos included and the yearly saving; the packs and
// the FAQ follow; "Start free trial" signs up and lands on Your plan with the same choice. No
// tier cards, no cost or budget figures.

describe('PricingScreen (21.5)', () => {
  it('starts at 3 channels monthly and shows the total, the videos and the trial', async () => {
    const { container } = render(<PricingScreen pricing={pricingView()} />);
    expect(
      screen.getByRole('heading', { name: 'One simple plan: pay per channel' }),
    ).toBeInTheDocument();
    expect(screen.getByText('3 channels')).toBeInTheDocument();
    expect(screen.getByText('£87.00 a month')).toBeInTheDocument();
    expect(screen.getByText(/£29\.00 per channel a month/)).toBeInTheDocument();
    expect(screen.getByText('24 videos a month included (8 per channel)')).toBeInTheDocument();
    expect(screen.getByText(/Try it free for 14 days with 5 videos/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Start free trial/ })).toHaveAttribute(
      'href',
      signUpHref({ channels: 3, interval: 'month' }),
    );
    // No old tiers, no long videos, no costs.
    expect(container.textContent).not.toMatch(/Basic|Plus|Enterprise|long video|budget|spend/i);
  });

  it('the stepper stays within 1–6 and the period switch changes the total and allowance', async () => {
    const user = userEvent.setup();
    render(<PricingScreen pricing={pricingView()} />);
    const more = screen.getByRole('button', { name: 'Add a channel' });
    const fewer = screen.getByRole('button', { name: 'Remove a channel' });
    for (let i = 0; i < 5; i += 1) await user.click(more);
    expect(screen.getByText('6 channels')).toBeInTheDocument();
    expect(more).toBeDisabled();
    for (let i = 0; i < 6; i += 1) await user.click(fewer);
    expect(screen.getByText('1 channel')).toBeInTheDocument();
    expect(fewer).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: 'Weekly' }));
    expect(screen.getByText('£9.50 a week')).toBeInTheDocument();
    expect(screen.getByText('2 videos a week included (2 per channel)')).toBeInTheDocument();
    expect(screen.getByText(/Weekly costs more than monthly/)).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Yearly' }));
    expect(screen.getByText('£290.00 a year')).toBeInTheDocument();
    expect(
      screen.getByText('96 videos a year included (8 per channel each month)'),
    ).toBeInTheDocument();
    expect(screen.getByText('2 months free: you save £58.00 a year')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Start free trial/ })).toHaveAttribute(
      'href',
      '/sign-up?next=%2Fsettings%2Fbilling%3Fchannels%3D1%26interval%3Dyear',
    );
  });

  it('lists the HD video packs and answers the FAQ with live prices', () => {
    render(<PricingScreen pricing={pricingView()} />);
    const packs = screen.getByRole('region', { name: 'Need more videos?' });
    expect(within(packs).getByText('5 HD videos')).toBeInTheDocument();
    expect(within(packs).getByText('£15.00')).toBeInTheDocument();
    expect(within(packs).getByText('15 HD videos')).toBeInTheDocument();
    expect(within(packs).getByText('£39.00')).toBeInTheDocument();
    expect(within(packs).getAllByText('Use on any channel within 3 months')).toHaveLength(2);
    expect(
      screen.getByText(/Monthly is £29\.00 per channel\. Weekly is £9\.50 per channel a week/),
    ).toBeInTheDocument();
  });

  it('shows "Price unavailable" rather than a made-up number when Stripe is unreachable', () => {
    render(<PricingScreen pricing={pricingView(null)} />);
    expect(screen.getByText(/Prices can’t be shown right now/)).toBeInTheDocument();
    expect(screen.getAllByText('Price unavailable').length).toBeGreaterThan(0);
  });

  it('a price changed in Stripe shows with no code change', () => {
    render(
      <PricingScreen pricing={pricingView(stripePrices({ studio_channel_monthly: 3_100 }))} />,
    );
    expect(screen.getByText('£93.00 a month')).toBeInTheDocument();
  });
});

describe('PricingScreen: quick posts count ¼ (23.3)', () => {
  it('says each channel’s videos can be up to 4× as many quick posts, in the card and the FAQ', async () => {
    const user = userEvent.setup();
    render(<PricingScreen pricing={pricingView()} />);
    expect(
      screen.getByText(
        'Every channel includes 8 short HD videos a month, or up to 32 quick posts.',
        { exact: false },
      ),
    ).toBeInTheDocument();
    // The plan card: 3 channels monthly = 24 videos or 96 quick posts.
    expect(
      screen.getByText('Or up to 96 quick posts: carousels, slideshows and text videos count as ¼'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Or up to 32 quick posts per channel a month: carousels, slideshows and text videos count as ¼ of a video',
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByText('Do carousels and slideshows count as a whole video?'));
    expect(
      screen.getByText(/so a channel’s 8 videos a month can be up to 32 quick posts/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Weekly' }));
    expect(
      screen.getByText('Or up to 24 quick posts: carousels, slideshows and text videos count as ¼'),
    ).toBeInTheDocument();
  });
});
