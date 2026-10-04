// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntlTestProvider } from '../../../../test/i18n-wrapper';
import { BusinessProvider } from '../business-context';
import { mockFetch, ok } from '../publications/test-utils';
import { PublicationsCalendar } from './publications-calendar';

// React error #418 on /calendar: the month heading and "Times are shown in your time zone: …"
// were rendered on the server in the server's zone (UTC in production) and again in the browser's
// zone during hydration. Node follows process.env.TZ changes, so the "server" render runs in UTC
// and the hydration in Auckland, like a New Zealand visitor of a UTC server.

const originalTz = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTz;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function ui(): ReactElement {
  return (
    <IntlTestProvider syncDocument={false}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <BusinessProvider>
          <PublicationsCalendar />
        </BusinessProvider>
      </SWRConfig>
    </IntlTestProvider>
  );
}

describe('PublicationsCalendar hydration', () => {
  it('renders no time-zone dependent text on the server', () => {
    process.env.TZ = 'UTC';
    const html = renderToString(ui());
    expect(html).not.toContain('Times are shown in your time zone');
    const page = document.createElement('div');
    page.innerHTML = html;
    // The month heading is reserved (a no-break space) until the browser knows its month.
    expect(page.querySelector('h2')?.textContent).toBe(' ');
  });

  it('hydrates in another time zone without a mismatch, then shows the browser zone', async () => {
    mockFetch(() => ok({ data: [], nextCursor: null }));
    process.env.TZ = 'UTC';
    const html = renderToString(ui());

    process.env.TZ = 'Pacific/Auckland';
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Pacific/Auckland');
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.append(container);
    const recoverable = vi.fn();
    await act(async () => {
      hydrateRoot(container, ui(), { onRecoverableError: recoverable });
    });

    expect(recoverable).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Times are shown in your time zone: Pacific/Auckland');
    const month = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(
      new Date(),
    );
    expect(container.querySelector('h2')?.textContent).toContain(month);
  });
});
