// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../test/i18n-wrapper';
import { LandingPage } from './landing-page';
import { LegalDocumentView } from './legal-document-view';
import { MarketingShell } from './marketing-shell';

// Phase 18 Track E — the public landing page, the marketing frame and the legal document view in
// en-GB, ar (right to left) and zh-Hans.

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

afterEach(() => vi.unstubAllGlobals());

describe('LandingPage', () => {
  it('tells the SME story and sends visitors to sign-up and pricing', () => {
    render(
      <MarketingShell entityName="Crumb Ltd">
        <LandingPage />
      </MarketingShell>,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'A week of short videos, made before your coffee cools.',
    );
    const trials = screen.getAllByRole('link', { name: /Start free trial/ });
    expect(trials.every((a) => a.getAttribute('href') === '/sign-up')).toBe(true);
    expect(screen.getAllByRole('link', { name: /pricing|Compare plans/i })[0]).toHaveAttribute(
      'href',
      '/pricing',
    );
    expect(screen.getByRole('heading', { name: 'Brief. Review. Publish.' })).toBeVisible();
    const platforms = screen.getByRole('heading', { name: 'One brief, cut for every feed' });
    expect(platforms.parentElement).toHaveTextContent('TikTok');
    const legal = screen.getByRole('navigation', { name: 'Legal' });
    expect(within(legal).getAllByRole('link')).toHaveLength(6);
    expect(within(legal).getByRole('link', { name: 'Data Processing Agreement' })).toHaveAttribute(
      'href',
      '/legal/dpa',
    );
    expect(screen.getByText(/Crumb Ltd/)).toBeVisible();
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
