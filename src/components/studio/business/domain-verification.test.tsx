// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail, mockFetch, ok, renderScreen } from '../publications/test-utils';
import { DomainVerificationCard, type DomainVerification } from './domain-verification';
import { ScanScheduleLine } from './scan-schedule';

// BACKLOG 13.10 schedule line, 13.11 DNS verification card and the ownership dispute.

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
afterEach(() => vi.unstubAllGlobals());

const PENDING: DomainVerification = {
  id: 'dv_1',
  domain: 'bakery.example',
  record: '_postmind-studio.bakery.example',
  recordType: 'TXT',
  value: 'pm-studio-verify=7f3c',
  state: 'PENDING',
  checkAttempts: 2,
  lastCheckedAt: '2026-09-27T10:00:00.000Z',
  lastError: 'No TXT record yet',
  verifiedAt: null,
  expiresAt: '2026-10-04T10:00:00.000Z',
  disputedAt: null,
  purgedAt: null,
};

describe('ScanScheduleLine', () => {
  it('shows the next rescan, the last unchanged check and the stock refresh', async () => {
    mockFetch(() =>
      ok({
        nextScanAt: '2026-10-20T03:30:00.000Z',
        nextStockRefreshAt: '2026-10-05T04:00:00.000Z',
        lastSkippedUnchangedAt: '2026-09-27T03:31:00.000Z',
        lastScanAt: '2026-09-20T10:00:00.000Z',
        intervalDays: 30,
      }),
    );
    renderScreen(<ScanScheduleLine businessId="biz_1" />);
    const line = await screen.findByLabelText('Scan schedule');
    expect(line).toHaveTextContent('Next automatic rescan');
    expect(line).toHaveTextContent('every 30 days');
    expect(line).toHaveTextContent('no changes, so no rescan');
    expect(line).toHaveTextContent('Stock photos refresh weekly');
  });

  it('explains when nothing is scheduled yet', async () => {
    mockFetch(() =>
      ok({
        nextScanAt: null,
        nextStockRefreshAt: null,
        lastSkippedUnchangedAt: null,
        lastScanAt: null,
        intervalDays: 30,
      }),
    );
    renderScreen(<ScanScheduleLine businessId="biz_1" />);
    expect(await screen.findByLabelText('Scan schedule')).toHaveTextContent(
      'Automatic rescans start after your first successful scan.',
    );
  });
});

describe('DomainVerificationCard', () => {
  it('requests a TXT record and shows it to copy', async () => {
    let created = false;
    const api = mockFetch((req) => {
      if (req.method === 'POST') {
        created = true;
        return { status: 201, body: { ok: true, verification: PENDING } };
      }
      return created ? ok({ verification: PENDING }) : fail(404, 'No domain verification');
    });
    const user = userEvent.setup();
    renderScreen(<DomainVerificationCard businessId="biz_1" />);
    await user.type(await screen.findByLabelText('Domain to verify'), 'bakery.example');
    await user.click(screen.getByRole('button', { name: 'Verify with DNS' }));
    expect(api.find('POST', '/businesses/biz_1/domain-verification')[0]?.body).toEqual({
      domain: 'bakery.example',
    });
    expect(await screen.findByText('_postmind-studio.bakery.example')).toBeInTheDocument();
    expect(screen.getByText('pm-studio-verify=7f3c')).toBeInTheDocument();
    expect(screen.getByText('Waiting for DNS')).toBeInTheDocument();
    expect(screen.getByText(/No TXT record yet/)).toBeInTheDocument();
  });

  it('shows the Enterprise refusal inline', async () => {
    mockFetch((req) =>
      req.method === 'POST'
        ? fail(403, 'Domain verification is available on the Enterprise plan', 'forbidden')
        : fail(404, 'none'),
    );
    const user = userEvent.setup();
    renderScreen(<DomainVerificationCard businessId="biz_1" />);
    await user.type(await screen.findByLabelText('Domain to verify'), 'bakery.example');
    await user.click(screen.getByRole('button', { name: 'Verify with DNS' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enterprise plan');
  });

  it('shows a verified domain', async () => {
    mockFetch(() =>
      ok({
        verification: { ...PENDING, state: 'VERIFIED', verifiedAt: '2026-09-27T11:00:00.000Z' },
      }),
    );
    renderScreen(<DomainVerificationCard businessId="biz_1" />);
    expect(await screen.findByText('Verified')).toBeInTheDocument();
    expect(screen.queryByLabelText('Domain to verify')).not.toBeInTheDocument();
  });

  it('disputes ownership only with a reason and the confirmation', async () => {
    const api = mockFetch((req) => {
      if (req.method === 'POST')
        return {
          status: 202,
          body: { ok: true, verification: { ...PENDING, state: 'DISPUTED' } },
        };
      return ok({ verification: PENDING });
    });
    const user = userEvent.setup();
    renderScreen(<DomainVerificationCard businessId="biz_1" />);
    await user.click(await screen.findByRole('button', { name: 'I don’t own the scanned site' }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Delete scraped content' });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText('What happened?'), 'Wrong site');
    expect(submit).toBeDisabled();
    await user.click(within(dialog).getByLabelText(/do not own or represent/));
    await user.click(submit);
    await waitFor(() =>
      expect(api.find('POST', '/businesses/biz_1/domain-verification/dispute')).toHaveLength(1),
    );
    expect(api.find('POST', '/businesses/biz_1/domain-verification/dispute')[0]?.body).toEqual({
      reason: 'Wrong site',
      confirmNotOwner: true,
    });
    expect(toast.success).toHaveBeenCalled();
  });
});
