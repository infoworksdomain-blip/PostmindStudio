// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail, mockFetch, ok, renderScreen } from '../publications/test-utils';
import { OWNERSHIP_STATEMENT, OWNERSHIP_STATEMENT_KEY, ScanPanel } from './scan-panel';
import type { ScanDetail, WebsiteScan } from './types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

const SCAN: WebsiteScan = {
  id: 'scan_1',
  businessId: 'biz_1',
  url: 'https://bakery.example/',
  state: 'SUCCEEDED',
  pagesCrawled: 12,
  imagesIngested: 9,
  errorReason: null,
  robotsBlocked: false,
  usedJsRender: false,
  costPence: 30,
  startedAt: '2026-09-20T10:00:00.000Z',
  completedAt: '2026-09-20T10:03:00.000Z',
};

const detail = (overrides: Partial<ScanDetail>): ScanDetail => ({
  ...SCAN,
  errors: [],
  library: { SCRAPED: 9, STOCK: 150 },
  ...overrides,
});

describe('ScanPanel', () => {
  it('shows history and the latest scan detail', async () => {
    mockFetch((req) =>
      req.url.pathname.endsWith('/scans')
        ? ok({ data: [SCAN] })
        : ok({ scan: detail({ errors: ['Timed out on /blog'] }) }),
    );
    renderScreen(<ScanPanel businessId="biz_1" />);
    expect(await screen.findByRole('list', { name: 'Scan history' })).toHaveTextContent(
      'bakery.example',
    );
    expect(await screen.findByText('159')).toBeInTheDocument();
    expect(screen.getByText('9 from your site · 150 stock')).toBeInTheDocument();
    expect(screen.getByText('Timed out on /blog')).toBeInTheDocument();
  });

  // 20.11 production bug (2026-09-30): the customer saw Anthropic's raw 400 JSON here.
  it('shows a friendly sentence, never raw provider JSON, when the AI service is unavailable', async () => {
    const raw =
      'anthropic/invalid_request: 400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC."},"request_id":"req_1"}';
    mockFetch((req) =>
      req.url.pathname.endsWith('/scans')
        ? ok({ data: [{ ...SCAN, state: 'FAILED' }] })
        : ok({
            scan: detail({
              state: 'FAILED',
              errors: [
                'service_unavailable: Every text_generation provider is unavailable: anthropic/account_limit until 2026-10-01T00:00:00.000Z, openai/insufficient_credits',
                raw,
                'service_unavailable: anthropic/account_limit',
              ],
            }),
          }),
    );
    renderScreen(<ScanPanel businessId="biz_1" />);
    const items = await screen.findAllByText(/Our AI service is temporarily unavailable/);
    expect(items).toHaveLength(2);
    const list = items[0]!.closest('ul')!;
    expect(list).not.toHaveTextContent('{');
    expect(list).not.toHaveTextContent('usage limits');
    expect(list).not.toHaveTextContent('openai');
    // A pre-20.11 row: the class sentence without the provider's text.
    expect(list).toHaveTextContent('Anthropic reported a problem: the request was rejected.');
  });

  it('requires the ownership warranty and sends it with the URL', async () => {
    const api = mockFetch((req) => {
      if (req.method === 'POST') return ok({ scanId: 'scan_2', scan: { ...SCAN, id: 'scan_2' } });
      if (req.url.pathname.endsWith('/scans')) return ok({ data: [] });
      return ok({ scan: detail({ id: 'scan_2', state: 'QUEUED', library: {} }) });
    });
    const user = userEvent.setup();
    renderScreen(<ScanPanel businessId="biz_1" />);
    await screen.findByText('No scans yet.');
    await user.type(screen.getByLabelText('Website address'), 'bakery.example');
    const submit = screen.getByRole('button', { name: 'Scan website' });
    expect(submit).toBeDisabled();
    // 14.4: the browser-render fallback policy is stated next to the confirmation.
    expect(screen.getByTestId('scan-render-policy')).toHaveTextContent(
      /only because you have confirmed it is your site.*never use this to get round another company/,
    );
    await user.click(screen.getByRole('checkbox'));
    await user.click(submit);
    await waitFor(() => expect(api.find('POST', '/businesses/biz_1/scan-website')).toHaveLength(1));
    const post = api.find('POST', '/businesses/biz_1/scan-website')[0]!;
    // 15.D8 / A11.2 / 17.8: the checkbox's locale, catalogue key and text travel with the request.
    expect(post.body).toEqual({
      url: 'bakery.example',
      ownershipConfirmed: true,
      ownershipStatement: {
        locale: 'en-GB',
        messageKey: OWNERSHIP_STATEMENT_KEY,
        text: OWNERSHIP_STATEMENT,
      },
    });
    expect(screen.getByText(OWNERSHIP_STATEMENT)).toBeInTheDocument();
    expect(post.headers['idempotency-key']).toBeTruthy();
    expect(await screen.findByText('Queued')).toBeInTheDocument();
  });

  it('polls a running scan until it finishes', async () => {
    let polls = 0;
    const api = mockFetch((req) => {
      if (req.url.pathname.endsWith('/scans'))
        return ok({ data: [{ ...SCAN, state: polls > 1 ? 'SUCCEEDED' : 'RUNNING' }] });
      if (req.url.pathname.endsWith('/business-profile')) return ok({ profile: {} });
      // 13.10 / 13.11 panels on the same screen: not part of this test.
      if (/\/(schedule|domain-verification)$/.test(req.url.pathname)) return fail(404, 'none');
      polls += 1;
      return ok({ scan: detail({ state: polls > 1 ? 'SUCCEEDED' : 'RUNNING', library: {} }) });
    });
    renderScreen(<ScanPanel businessId="biz_1" />);
    expect(await screen.findByText('Scanning your site')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Done').length).toBeGreaterThan(0), {
      timeout: 6000,
    });
    expect(api.find('GET', '/scans/scan_1').length).toBeGreaterThanOrEqual(2);
  }, 10_000);

  it('follows the running scan when one is already in progress (409)', async () => {
    const { toast } = await import('sonner');
    mockFetch((req) => {
      if (req.method === 'POST')
        return {
          status: 409,
          body: {
            ok: false,
            error: 'conflict',
            message: 'A scan for this business is already in progress',
            details: { scanId: 'scan_9' },
          },
        };
      if (req.url.pathname.endsWith('/scans')) return ok({ data: [] });
      return ok({
        scan: detail({ id: 'scan_9', url: 'https://running.example/', state: 'RUNNING' }),
      });
    });
    const user = userEvent.setup();
    renderScreen(<ScanPanel businessId="biz_1" />);
    await screen.findByText('No scans yet.');
    await user.type(screen.getByLabelText('Website address'), 'x.example');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Scan website' }));
    expect(await screen.findByText('https://running.example/')).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('A scan for this business is already in progress');
  });

  it('shows a history error', async () => {
    mockFetch(() => fail(500, 'History down'));
    renderScreen(<ScanPanel businessId="biz_1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('History down');
  });
});
