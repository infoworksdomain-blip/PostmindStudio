// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fail,
  mockFetch,
  ok,
  renderScreen,
  type RecordedRequest,
} from '../publications/test-utils';
import { BusinessDetailsCard, normaliseDomain } from './business-details-card';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

describe('normaliseDomain', () => {
  it('accepts what the server accepts and returns what it would store', () => {
    expect(normaliseDomain('Leedssourdough.CO.uk')).toBe('leedssourdough.co.uk');
    expect(normaliseDomain('https://leedssourdough.co.uk/')).toBe('leedssourdough.co.uk');
  });

  it('refuses paths, ports, spaces and bare words', () => {
    for (const bad of ['leeds', 'a b.co', 'x.co/path', 'x.co:8080', '']) {
      expect(normaliseDomain(bad), bad).toBeNull();
    }
  });
});

function serve(local = true) {
  return mockFetch((req: RecordedRequest) => {
    if (req.url.pathname === '/api/studio/me')
      return ok({
        me: { capabilities: ['studio:business:manage'], user: { platformRole: 'user' } },
      });
    if (req.url.pathname === '/api/studio/businesses' && req.method === 'GET')
      return ok({
        data: [{ id: 'biz_1', name: 'Leeds Sourdough', domain: 'old.example.com' }],
        local,
      });
    if (req.method === 'PATCH') return ok({ business: { id: 'biz_1' } });
    return fail(404, 'nope', 'not_found');
  });
}

describe('BusinessDetailsCard', () => {
  it('renames the business and sets its website through PATCH /businesses/:id', async () => {
    const api = serve();
    const user = userEvent.setup();
    renderScreen(<BusinessDetailsCard businessId="biz_1" />);
    const name = await screen.findByLabelText('Business name');
    const save = screen.getByRole('button', { name: 'Save details' });
    expect(save).toBeDisabled();
    await user.clear(name);
    await user.type(name, 'Leeds Sourdough Co');
    const domain = screen.getByLabelText('Website address (optional)');
    await user.clear(domain);
    await user.type(domain, 'https://Leeds.CO.uk/');
    await user.click(save);
    await waitFor(() => expect(api.find('PATCH', '/businesses/biz_1')).toHaveLength(1));
    expect(api.find('PATCH', '/businesses/biz_1')[0]?.body).toEqual({
      name: 'Leeds Sourdough Co',
      domain: 'leeds.co.uk',
    });
  });

  it('refuses a website that is not a host name, and clears it with an empty field', async () => {
    const api = serve();
    const user = userEvent.setup();
    renderScreen(<BusinessDetailsCard businessId="biz_1" />);
    const domain = await screen.findByLabelText('Website address (optional)');
    await user.clear(domain);
    await user.type(domain, 'not a site');
    expect(screen.getByText('Use a host name such as example.co.uk.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save details' })).toBeDisabled();
    await user.clear(domain);
    await user.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(api.find('PATCH', '/businesses/biz_1')).toHaveLength(1));
    expect(api.find('PATCH', '/businesses/biz_1')[0]?.body).toEqual({
      name: 'Leeds Sourdough',
      domain: null,
    });
  });

  it('is not shown where PostMind Core owns the business list', async () => {
    serve(false);
    renderScreen(<BusinessDetailsCard businessId="biz_1" />);
    await waitFor(() => expect(screen.queryByLabelText('Business name')).toBeNull());
    expect(screen.queryByText('Business details')).toBeNull();
  });
});
