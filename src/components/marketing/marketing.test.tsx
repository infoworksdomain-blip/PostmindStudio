// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../test/i18n-wrapper';
import { LandingPage } from './landing-page';
import { LegalDocumentView } from './legal-document-view';
import { MarketingShell } from './marketing-shell';

// Phase 18 Track E / 25.5 — the public landing page, the marketing frame and the legal document view
// in en-GB, ar (right to left) and zh-Hans.

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

afterEach(() => vi.unstubAllGlobals());

describe('LandingPage', () => {
  it('teases one price per channel from the channel plan, never budgets, spend or cost caps', () => {
    render(<LandingPage />);
    const pricing = screen
      .getByRole('heading', { name: 'One simple price per channel' })
      .closest('section') as HTMLElement;
    expect(pricing).toHaveTextContent('£29');
    expect(pricing).toHaveTextContent('per channel a month');
    expect(pricing).toHaveTextContent('8 short HD videos a month, or up to 32 quick posts');
    expect(pricing).toHaveTextContent('¼ of a video');
    expect(pricing).not.toHaveTextContent(/budget|spending|cost/i);
    expect(within(pricing).getByRole('link', { name: /See pricing/ })).toHaveAttribute(
      'href',
      '/pricing',
    );
  });

  it('says what Studio does and sends visitors to sign-up and pricing', () => {
    render(
      <MarketingShell entityName="Crumb Ltd">
        <LandingPage />
      </MarketingShell>,
    );
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent('Create, plan and publish your social videos from one brief.');
    expect(h1).not.toHaveTextContent(/coffee cools/);
    const trials = screen.getAllByRole('link', { name: /Start free trial/ });
    expect(trials.length).toBeGreaterThanOrEqual(3);
    expect(trials.every((a) => a.getAttribute('href') === '/sign-up')).toBe(true);
    expect(screen.getAllByRole('link', { name: /See pricing/ })[0]).toHaveAttribute(
      'href',
      '/pricing',
    );
    const legal = screen.getByRole('navigation', { name: 'Legal' });
    expect(within(legal).getAllByRole('link')).toHaveLength(6);
    expect(within(legal).getByRole('link', { name: 'Data Processing Agreement' })).toHaveAttribute(
      'href',
      '/legal/dpa',
    );
    expect(screen.getByText(/Crumb Ltd/)).toBeVisible();
  });

  it('heads every page with the brand logo (eager, named once by the home link) on all widths', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    render(
      <MarketingShell>
        <p>page</p>
      </MarketingShell>,
    );
    const header = screen.getByRole('banner');
    const home = within(header).getByRole('link', { name: 'PostMind Studio home' });
    const logo = home.querySelector('img[data-brand-logo="light"]');
    expect(logo).toHaveAttribute('loading', 'eager');
    // 26.2: the lockup is never hidden on phones (no max-sm:sr-only / hidden wrapper).
    expect(home.innerHTML).not.toMatch(/sr-only|max-sm:hidden/);
    // The switchers move to the footer below sm, so the phone header fits at 320 px.
    const footer = screen.getByRole('contentinfo');
    expect(
      within(footer).getByRole('combobox', { name: /Interface language/ }),
    ).toBeInTheDocument();
    expect(within(footer).getByRole('img', { name: 'PostMind Studio' })).toBeInTheDocument();
  });

  it('has the ten sections in order, each a labelled region with one h2', () => {
    const { container } = render(<LandingPage />);
    const titles = [...container.querySelectorAll('section[aria-labelledby]')].map(
      (s) => document.getElementById(s.getAttribute('aria-labelledby')!)?.textContent,
    );
    expect(titles).toEqual([
      'Create, plan and publish your social videos from one brief.',
      'Every kind of post a small business needs.',
      'A finished video from one sentence.',
      'Your month, on one calendar.',
      'One post, every platform you use.',
      'One prompt, a month of posts.',
      'See what works, then make more of it.',
      'Your colours, your voice, your sign-off.',
      'One simple price per channel',
      'Make your first post today.',
    ]);
  });

  it('names the platforms as text, the real features and no provider or safety claim', () => {
    const { container } = render(<LandingPage />);
    const platforms = screen.getByRole('list', { name: 'Platforms Studio publishes to' });
    expect(
      within(platforms)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['TikTok', 'Instagram', 'YouTube Shorts', 'Facebook', 'LinkedIn', 'X']);
    for (const feature of [
      'Plan my month',
      'Blitz',
      'Automations',
      'Approvals that fit your team',
    ]) {
      expect(screen.getByText(feature)).toBeVisible();
    }
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/content safety|Seedance|Runway|Luma|Kling|Veo|AI-powered/i);
    expect(text).not.toMatch(/Stock photos/);
  });

  it('renders in Arabic (right to left) and Simplified Chinese', () => {
    const ar = render(withLocale('ar', <LandingPage />));
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/[؀-ۿ]/);
    ar.unmount();
    render(withLocale('zh-Hans', <LandingPage />));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/[一-鿿]/);
    expect(screen.getAllByRole('link', { name: /[一-鿿]/ })[0]).toHaveAttribute('href', '/sign-up');
  });
});

describe('LegalDocumentView', () => {
  const md =
    '<!-- OPERATOR MUST REPLACE -->\n# Terms of Service\n\nHello **world**.\n\n<script>alert(1)</script>';

  it('renders the Markdown, skips raw HTML and flags the placeholder', () => {
    const { container } = render(
      <LegalDocumentView docKey="terms" markdown={md} placeholder fallback={false} />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Terms of Service' })).toBeVisible();
    expect(screen.getByText('This document has not been published yet.')).toBeVisible();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).not.toContain('OPERATOR MUST REPLACE');
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('renders Markdown pipe tables as real tables', () => {
    const tableMd =
      '# Sub-processors\n\n| Provider | Purpose |\n| --- | --- |\n| Pixabay | Stock images |\n';
    const { container } = render(
      <LegalDocumentView
        docKey="subprocessors"
        markdown={tableMd}
        placeholder={false}
        fallback={false}
      />,
    );
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Provider' })).toBeVisible();
    expect(within(table).getByRole('cell', { name: 'Pixabay' })).toBeVisible();
    expect(container.textContent).not.toContain('| --- |');
  });

  it('links only http(s), mailto and relative targets; anything else is plain text', () => {
    const links = [
      '[web](https://example.com/a)',
      '[plain](http://example.com)',
      '[mail](mailto:legal@example.com)',
      '[rel](/legal/privacy)',
      '[anchor](#cookies)',
      '[js](javascript:alert(1))',
      '[tel](tel:+441234567890)',
      '[data](data:text/html;base64,PHNjcmlwdD4=)',
      '[ftp](ftp://example.com/file)',
      '[proto](//evil.example/x)',
    ].join('\n\n');
    const { container } = render(
      <LegalDocumentView docKey="terms" markdown={links} placeholder={false} fallback={false} />,
    );
    const article = container.querySelector('article')!;
    const hrefs = [...article.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      'https://example.com/a',
      'http://example.com',
      'mailto:legal@example.com',
      '/legal/privacy',
      '#cookies',
    ]);
    for (const text of ['js', 'tel', 'data', 'ftp', 'proto']) {
      const el = within(article).getByText(text);
      expect(el.tagName).toBe('SPAN');
      expect(el.closest('a')).toBeNull();
    }
  });

  it('marks a draft with details to fill in, and hides the drafting comment', () => {
    const draft =
      '<!-- Draft prepared 2026-09-30; have a solicitor review it -->\n# Privacy Policy\n\nWrite to [[PRIVACY EMAIL]].';
    const { container } = render(
      <LegalDocumentView docKey="privacy" markdown={draft} placeholder draft fallback={false} />,
    );
    expect(screen.getByText('This document is a draft.')).toBeVisible();
    expect(screen.queryByText('This document has not been published yet.')).toBeNull();
    expect(container.textContent).not.toContain('Draft prepared');
    expect(container.textContent).toContain('[[PRIVACY EMAIL]]');
  });

  it('notes an English fallback in other locales (ar, zh-Hans)', () => {
    const ar = render(
      withLocale(
        'ar',
        <LegalDocumentView docKey="privacy" markdown="# Privacy" placeholder={false} fallback />,
      ),
    );
    expect(screen.getByRole('note').textContent).toMatch(/[؀-ۿ]/);
    expect(screen.queryByText('This document has not been published yet.')).toBeNull();
    ar.unmount();
    render(
      withLocale(
        'zh-Hans',
        <LegalDocumentView docKey="dpa" markdown="# DPA" placeholder fallback={false} />,
      ),
    );
    expect(screen.getByRole('note').textContent).toMatch(/[一-鿿]/);
  });
});
