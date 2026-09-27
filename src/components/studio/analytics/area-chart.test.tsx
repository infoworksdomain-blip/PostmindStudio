// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AreaChart } from './area-chart';

const points = [
  { label: '1 Sep', value: 10 },
  { label: '2 Sep', value: 40 },
  { label: '3 Sep', value: 25 },
];

describe('AreaChart', () => {
  it('exposes the series as a labelled image and a data table', () => {
    render(<AreaChart points={points} label="Views per day" formatValue={(v) => `${v} views`} />);
    expect(screen.getByRole('img', { name: /Views per day/ })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Views per day' });
    expect(table).toHaveTextContent('2 Sep40 views');
  });

  it('reads points aloud with the keyboard', async () => {
    const user = userEvent.setup();
    render(<AreaChart points={points} label="Views per day" formatValue={(v) => `${v} views`} />);
    await user.tab();
    expect(screen.getByRole('img', { name: /Views per day/ })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getAllByText(/1 Sep/).length).toBeGreaterThan(1);
    await user.keyboard('{End}');
    expect(screen.getByText('3 Sep: 25 views', { selector: 'p' })).toBeInTheDocument();
    await user.keyboard('{Home}');
    expect(screen.getByText('1 Sep: 10 views', { selector: 'p' })).toBeInTheDocument();
  });

  it('scales the axis to a nice ceiling', () => {
    render(<AreaChart points={points} label="Views" formatValue={(v) => String(v)} />);
    expect(screen.getByText('50')).toBeInTheDocument();
    expect(screen.getByText('25', { selector: 'span' })).toBeInTheDocument();
  });
});
