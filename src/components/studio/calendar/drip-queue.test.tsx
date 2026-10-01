// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { presetSlots } from '@/lib/studio/drip-presets';
import { mockFetch, ok, renderScreen } from '../publications/test-utils';
import { useBusiness } from '../business-context';
import { DripQueuePanel, type DripQueueView } from './drip-queue';

// 20.14 — the posting-schedule editor in the calendar's drip-queue panel: Every day (1–4 a day)
// or N a week on chosen days; times chosen / picked by the system / at intervals; time zone;
// summary and the next 7 days; Advanced per-slot list; what is sent to PUT …/drip-queue.

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

const QUEUE = '/businesses/biz_1/drip-queue';
const ZONE = 'Europe/London';

const view = (over: Partial<DripQueueView> = {}): DripQueueView => ({
  slots: [],
  schedule: null,
  platforms: [],
  enabled: true,
  staggerMinutes: 30,
  nextSlotAt: null,
  queued: 0,
  upcoming: [],
  ...over,
});

function server(initial: DripQueueView | null) {
  let current = initial;
  return mockFetch((req) => {
    if (!req.url.pathname.endsWith('/drip-queue')) return undefined;
    if (req.method === 'PUT') current = view(req.body as Partial<DripQueueView>);
    return ok({ dripQueue: current });
  });
}

type Body = {
  schedule: Record<string, unknown>;
  slots: Array<{ weekday: number; time: string; timezone: string }>;
  enabled: boolean;
};
const sent = (api: ReturnType<typeof mockFetch>) => api.find('PUT', QUEUE).at(-1)!.body as Body;
const keys = (b: Body) => b.slots.map((s) => `${s.weekday}@${s.time}`);

async function open(initial: DripQueueView | null = null) {
  const api = server(initial);
  const user = userEvent.setup();
  renderScreen(<DripQueuePanel />);
  await screen.findByRole('heading', { name: 'Drip queue' });
  return { api, user };
}

describe('DripQueuePanel posting schedule (20.14)', () => {
  it('a new queue starts as every day, once a day, at the system time', async () => {
    const { api, user } = await open(null);
    expect(screen.getByRole('radio', { name: 'Every day' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Pick times for me' })).toBeChecked();
    expect(screen.getByText('Posts go out at 12:30.')).toBeInTheDocument();
    expect(screen.getByLabelText('Time zone')).toHaveValue(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    expect(
      within(screen.getByRole('list', { name: 'Next 7 days' })).getAllByRole('listitem'),
    ).toHaveLength(7);
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(api.find('PUT', QUEUE)).toHaveLength(1));
    const body = sent(api);
    expect(body.enabled).toBe(true);
    expect(body.schedule).toMatchObject({ mode: 'daily', postsPerDay: 1, timesMode: 'system' });
    expect(body.slots).toHaveLength(7);
  });

  it('daily: posts a day 1–4 with the system times and a summary', async () => {
    const { api, user } = await open(view({ slots: presetSlots('three', ZONE), enabled: false }));
    // The 20.3 "3 a week" plan reopens as a weekly schedule.
    expect(screen.getByRole('radio', { name: 'Times a week' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Every day' }));
    await user.click(screen.getByRole('radio', { name: 'Pick times for me' }));
    await user.selectOptions(screen.getByLabelText('Posts a day'), '4');
    expect(screen.getByText('Posts go out at 09:00, 12:30, 17:30 and 20:00.')).toBeInTheDocument();
    expect(screen.getByTestId('schedule-summary')).toHaveTextContent(
      '4 posts a day · at 09:00, 12:30, 17:30 and 20:00 · Europe/London',
    );
    expect(screen.getByLabelText('Posts a day').querySelectorAll('option')).toHaveLength(4);
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(api.find('PUT', QUEUE)).toHaveLength(1));
    expect(sent(api).slots).toHaveLength(28);
  });

  it('daily: I’ll choose the times, validated in order and 30 minutes apart', async () => {
    const { api, user } = await open(null);
    await user.selectOptions(screen.getByLabelText('Posts a day'), '2');
    await user.click(screen.getByRole('radio', { name: 'I’ll choose the times' }));
    const first = screen.getByLabelText('Post 1');
    const second = screen.getByLabelText('Post 2');
    expect(first).toHaveValue('09:00');
    expect(second).toHaveValue('17:30');
    fireEvent.change(second, { target: { value: '09:15' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Posts on the same day must be at least 30 minutes apart.',
    );
    expect(screen.getByRole('button', { name: 'Save schedule' })).toBeDisabled();
    fireEvent.change(second, { target: { value: '08:00' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Post times must be in order');
    fireEvent.change(second, { target: { value: '19:45' } });
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(api.find('PUT', QUEUE)).toHaveLength(1));
    expect(sent(api).schedule).toMatchObject({ timesMode: 'choose', times: ['09:00', '19:45'] });
    expect(keys(sent(api)).filter((k) => k.startsWith('1@'))).toEqual(['1@09:00', '1@19:45']);
  });

  it('daily: every N hours from a start time, or spread across posting hours', async () => {
    const { api, user } = await open(null);
    await user.selectOptions(screen.getByLabelText('Posts a day'), '4');
    await user.click(screen.getByRole('radio', { name: 'At regular intervals' }));
    expect(screen.getByLabelText('Every')).toHaveValue('180');
    expect(screen.getByLabelText('Starting at')).toHaveValue('09:00');
    expect(screen.getByTestId('schedule-summary')).toHaveTextContent(
      '4 posts a day · every 3 hours from 09:00 · Europe/London'.replace(
        'Europe/London',
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      ),
    );
    fireEvent.change(screen.getByLabelText('Starting at'), { target: { value: '16:00' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('runs past midnight');
    fireEvent.change(screen.getByLabelText('Starting at'), { target: { value: '08:00' } });
    await user.click(screen.getByRole('radio', { name: 'Spread across my posting hours' }));
    expect(screen.getByLabelText('Posting hours from')).toHaveValue('08:00');
    expect(screen.getByLabelText('Until')).toHaveValue('21:00');
    expect(screen.getByText('Posts go out at 08:00, 12:20, 16:40 and 21:00.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(api.find('PUT', QUEUE)).toHaveLength(1));
    expect(sent(api).schedule).toMatchObject({ timesMode: 'interval', intervalBy: 'system' });
  });

  it('daily: untick a day to skip it', async () => {
    const { api, user } = await open(null);
    await user.click(screen.getByRole('checkbox', { name: 'Sunday' }));
    expect(screen.getByTestId('schedule-summary')).toHaveTextContent('1 post a day · on Mon');
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(api.find('PUT', QUEUE)).toHaveLength(1));
    expect(sent(api).slots.some((s) => s.weekday === 0)).toBe(false);
    expect(sent(api).slots).toHaveLength(6);
  });

  it('weekly: N a week on chosen days, validated against 4 a day', async () => {
    const { api, user } = await open(null);
    await user.click(screen.getByRole('radio', { name: 'Times a week' }));
    expect(screen.getByLabelText('Posts a week')).toHaveValue('3');
    for (const day of ['Monday', 'Wednesday', 'Friday'])
      expect(screen.getByRole('checkbox', { name: day })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Tuesday' })).not.toBeChecked();
    await user.selectOptions(screen.getByLabelText('Posts a week'), '10');
    // 10 a week fits on Mon/Wed/Fri (≤ 4 a day), so the days stay.
    expect(screen.getByRole('checkbox', { name: 'Monday' })).toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'Friday' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('At most 4 posts a day');
    await user.click(screen.getByRole('checkbox', { name: 'Friday' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('schedule-summary')).toHaveTextContent(
      /^10 posts a week · on Mon, Wed and Fri · at 09:00, 12:30, 17:30 and 20:00/,
    );
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(api.find('PUT', QUEUE)).toHaveLength(1));
    const body = sent(api);
    expect(body.schedule).toMatchObject({ mode: 'weekly', postsPerWeek: 10, days: [1, 3, 5] });
    expect(body.slots).toHaveLength(10);
  });

  it('reopens a saved schedule in the same mode and changes the time zone', async () => {
    const schedule = {
      mode: 'weekly' as const,
      timezone: 'Africa/Lagos',
      postsPerDay: 1,
      postsPerWeek: 2,
      days: [2, 4],
      timesMode: 'choose' as const,
      times: ['07:45'],
      intervalBy: 'user' as const,
      intervalStart: '09:00',
      intervalMinutes: 180,
      windowStart: '08:00',
      windowEnd: '21:00',
    };
    const slots = [2, 4].map((weekday) => ({ weekday, time: '07:45', timezone: 'Africa/Lagos' }));
    const { api, user } = await open(view({ slots, schedule }));
    expect(screen.getByRole('radio', { name: 'Times a week' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'I’ll choose the times' })).toBeChecked();
    expect(screen.getByLabelText('Post 1')).toHaveValue('07:45');
    expect(screen.queryByRole('button', { name: 'Save schedule' })).toBeNull();
    await user.selectOptions(screen.getByLabelText('Time zone'), ZONE);
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(api.find('PUT', QUEUE)).toHaveLength(1));
    expect(sent(api).slots.every((s) => s.timezone === ZONE)).toBe(true);
  });

  it('Advanced lists the generated slots; editing one makes the schedule custom', async () => {
    const { api, user } = await open(null);
    await user.click(screen.getByText('Advanced: edit each time (7)'));
    expect(screen.getAllByLabelText(/^Slot \d day$/)).toHaveLength(7);
    fireEvent.change(screen.getByLabelText('Slot 1 time'), { target: { value: '06:15' } });
    expect(screen.getByText(/These times were set one by one under Advanced/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Every day' })).not.toBeChecked();
    expect(screen.getByTestId('schedule-summary')).toHaveTextContent(
      '7 posts a week, set one by one',
    );
    await user.click(screen.getByRole('button', { name: 'Add slot' }));
    expect(screen.getAllByLabelText(/^Slot \d day$/)).toHaveLength(8);
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(api.find('PUT', QUEUE)).toHaveLength(1));
    const body = sent(api);
    expect(body.schedule).toMatchObject({ mode: 'custom' });
    expect(body.slots).toHaveLength(8);
    expect(keys(body)[0]).toBe('1@06:15');
  });

  it('Advanced refuses more than 4 slots on one day', async () => {
    const { user } = await open(null);
    await user.click(screen.getByText('Advanced: edit each time (7)'));
    for (let i = 0; i < 4; i += 1)
      await user.click(screen.getByRole('button', { name: 'Add slot' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('At most 4 times on any day');
    expect(screen.getByRole('button', { name: 'Save schedule' })).toBeDisabled();
  });

  it('switching business drops unsaved edits instead of saving them to the other business', async () => {
    const daily = view({ slots: presetSlots('three', ZONE) });
    mockFetch((req) => {
      if (!req.url.pathname.endsWith('/drip-queue')) return undefined;
      return ok({ dripQueue: daily });
    });
    function Switch() {
      const { setBusinessId } = useBusiness();
      return (
        <button type="button" onClick={() => setBusinessId('biz_2')}>
          Switch business
        </button>
      );
    }
    const user = userEvent.setup();
    renderScreen(
      <>
        <Switch />
        <DripQueuePanel />
      </>,
    );
    await screen.findByRole('heading', { name: 'Drip queue' });
    expect(screen.getByRole('radio', { name: 'Times a week' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Every day' }));
    expect(screen.getByRole('radio', { name: 'Every day' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Switch business' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Times a week' })).toBeChecked());
  });
});
