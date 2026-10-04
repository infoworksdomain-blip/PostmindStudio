// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PricingScreen } from './pricing-screen';
import { pricingView, stripePrices } from './test-fixtures';

// Phase 18 Track C — "pricing page renders amounts from mocked prices.list": the view is built
// by the real buildPricingView from mocked Stripe prices.

function card(name: string) {
  return screen.getByRole('listitem', { name });
}

describe('PricingScreen', () => {
  it('renders monthly amounts from Stripe prices, the trial and VAT notes', () => {
    render(<PricingScreen pricing={pricingView()} salesEmail="sales@studio.test" />);
    expect(within(card('Basic')).getByText('£29.00 / month')).toBeInTheDocument();
    expect(within(card('Standard')).getByText('£99.00 / month')).toBeInTheDocument();
    expect(within(card('Plus')).getByText('£349.00 / month')).toBeInTheDocument();
    expect(
      within(card('Standard')).getByRole('link', { name: /Start free trial/ }),
    ).toHaveAttribute('href', '/sign-up?plan=STANDARD&interval=month');
    expect(
      within(card('Basic')).getByRole('link', { name: 'Choose the Basic plan' }),
    ).toHaveAttribute('href', '/sign-up?plan=BASIC&interval=month');
    expect(
      within(card('Enterprise')).getByRole('link', {
        name: 'Email the sales team about Enterprise',
      }),
    ).toHaveAttribute('href', 'mailto:sales@studio.test');
    expect(screen.getByText('Prices exclude VAT.')).toBeInTheDocument();
    expect(screen.getByText(/Try Standard free for 14 days/)).toBeInTheDocument();
  });

  it('shows a price change from Stripe with no code change', () => {
    render(<PricingScreen pricing={pricingView(stripePrices({ studio_basic_monthly: 6_500 }))} />);
    expect(within(card('Basic')).getByText('£65.00 / month')).toBeInTheDocument();
  });

  it('switches to annual prices with the saving', async () => {
    const user = userEvent.setup();
    render(<PricingScreen pricing={pricingView()} />);
    await user.click(screen.getByRole('radio', { name: 'Annual' }));
    expect(screen.getByRole('radio', { name: 'Annual' })).toHaveAttribute('aria-checked', 'true');
    expect(within(card('Basic')).getByText('£290.00 / year')).toBeInTheDocument();
    // 12 × £29 − £290 = £58.
    expect(within(card('Basic')).getByText('Save £58.00 a year')).toBeInTheDocument();
    expect(
      within(card('Standard')).getByRole('link', { name: /Start free trial/ }),
    ).toHaveAttribute('href', '/sign-up?plan=STANDARD&interval=year');
  });

  it('never invents numbers when Stripe is unavailable, and hides the sales link without an email', () => {
    render(<PricingScreen pricing={pricingView(null)} />);
    expect(screen.getByRole('status')).toHaveTextContent('Prices can’t be shown right now');
    expect(within(card('Basic')).getByText('Price unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/£29/)).toBeNull();
    expect(within(card('Enterprise')).queryByRole('link')).toBeNull();
    expect(
      within(card('Enterprise')).getByText(/Ask your PostMind account manager/),
    ).toBeInTheDocument();
  });

  it('21.3 shows each plan’s AI video quality on the cards and in the table', () => {
    render(<PricingScreen pricing={pricingView()} />);
    expect(within(card('Basic')).getByText('Video quality: SD (480p)')).toBeInTheDocument();
    expect(
      within(card('Standard')).getByText('Video quality: Standard HD (720p)'),
    ).toBeInTheDocument();
    expect(within(card('Plus')).getByText('Video quality: Full HD (1080p)')).toBeInTheDocument();
    expect(
      within(card('Enterprise')).getByText('Video quality: Full HD (1080p)'),
    ).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Plan comparison' });
    const row = within(table).getByRole('row', { name: /AI video quality/ });
    expect(
      within(row)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['SD (480p)', 'Standard HD (720p)', 'Full HD (1080p)', 'Full HD (1080p)']);
  });

  it('builds the comparison table from the catalogue with accessible ticks', () => {
    render(<PricingScreen pricing={pricingView()} />);
    const table = screen.getByRole('table', { name: 'Plan comparison' });
    const voice = within(table).getByRole('row', { name: /Brand voice clone/ });
    const cells = within(voice).getAllByRole('cell');
    expect(cells.map((c) => c.textContent)).toEqual([
      'Not included',
      'Not included',
      'Included',
      'Included',
    ]);
    expect(within(table).getByRole('row', { name: /^Seats/ })).toHaveTextContent(
      'Seats2515Unlimited',
    );
    expect(within(table).getByRole('row', { name: /Long videos a month/ })).toHaveTextContent(
      '1 × up to 3 min',
    );
    expect(within(table).getByRole('row', { name: /Monthly generation budget/ })).toHaveTextContent(
      '£20.00£73.00£264.00£1,100.00',
    );
  });

  it('lists top-up packs with Stripe amounts', () => {
    render(<PricingScreen pricing={pricingView()} />);
    const packs = screen.getByRole('heading', { name: 'Top-up packs' }).closest('section')!;
    expect(within(packs).getAllByText('10 short videos')).toHaveLength(3);
    expect(within(packs).getByText('£55.00')).toBeInTheDocument();
  });
});
