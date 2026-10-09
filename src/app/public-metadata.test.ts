import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTranslator } from 'next-intl';
import type { Metadata } from 'next';
import messages from '../../messages/en-GB.json';
import { LEGAL_DOCS } from '@/lib/legal/documents';
import { publicPageMetadata } from '@/lib/seo/page-metadata';

// 26.2 — every public page has a canonical URL, og:url, its own description and both preview
// images; utility and signed-in pages stay out of search results.

vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en-GB',
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en-GB', messages, namespace: namespace as never }),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [] }) }));

const homePage = () => import('./(marketing)/page');
const signIn = () => import('./(auth)/sign-in/page');
const signUp = () => import('./(auth)/sign-up/page');
const forgot = () => import('./(auth)/forgot-password/page');
const legal = () => import('./(marketing)/legal/[doc]/page');

function images(value: unknown): string[] {
  return ([] as unknown[])
    .concat(value ?? [])
    .map((i) => (typeof i === 'object' && i && 'url' in i ? String(i.url) : String(i)));
}

async function publicPages(): Promise<Array<[string, Metadata]>> {
  const pages: Array<[string, Metadata]> = [
    ['/', await (await homePage()).generateMetadata()],
    ['/sign-in', await (await signIn()).generateMetadata()],
    ['/sign-up', await (await signUp()).generateMetadata()],
    ['/forgot-password', await (await forgot()).generateMetadata()],
  ];
  const { generateMetadata } = await legal();
  for (const doc of LEGAL_DOCS) {
    pages.push([`/legal/${doc}`, await generateMetadata({ params: Promise.resolve({ doc }) })]);
  }
  return pages;
}

// Importing the pages pulls in their screens; on a loaded machine that alone can take ~20 s.
const IMPORT_TIMEOUT = 120_000;
let pages: Array<[string, Metadata]> = [];
beforeAll(async () => {
  pages = await publicPages();
}, IMPORT_TIMEOUT);

describe('public page metadata', () => {
  it('gives every page a canonical URL and a matching og:url', async () => {
    for (const [path, meta] of pages) {
      expect(meta.alternates?.canonical, path).toBe(path);
      expect((meta.openGraph as { url?: string } | undefined)?.url, path).toBe(path);
    }
  });

  it('names the Open Graph and X images on every page, the home page included', async () => {
    for (const [path, meta] of pages) {
      expect(images(meta.openGraph?.images), path).toEqual(['/opengraph-image']);
      expect(images(meta.twitter?.images), path).toEqual(['/twitter-image']);
    }
  });

  it('writes a different description for each page', async () => {
    const descriptions = pages.map(([, m]) => m.description);
    expect(descriptions.every((d) => typeof d === 'string' && d.length > 60)).toBe(true);
    expect(new Set(descriptions).size).toBe(pages.length);
  });

  it('keeps forgot-password out of the index but indexes sign-in and sign-up', async () => {
    const byPath = new Map(pages);
    expect(byPath.get('/forgot-password')?.robots).toMatchObject({ index: false });
    expect(byPath.get('/sign-in')?.robots).toMatchObject({ index: true });
    expect(byPath.get('/sign-up')?.robots).toMatchObject({ index: true });
  });
});

describe('noindex pages', () => {
  it.each([
    ['reset-password', () => import('./(auth)/reset-password/page')],
    ['verify-email', () => import('./(auth)/verify-email/page')],
    ['two-factor', () => import('./(auth)/two-factor/page')],
    ['invite', () => import('./(auth)/invite/[token]/page')],
  ])(
    '%s is noindex',
    async (_name, load) => {
      const meta = await (await load()).generateMetadata();
      expect(meta.robots).toMatchObject({ index: false });
    },
    IMPORT_TIMEOUT,
  );

  it(
    'the signed-in app layout is noindex',
    async () => {
      const { metadata } = await import('./(studio)/layout');
      expect(metadata.robots).toMatchObject({ index: false, follow: false });
    },
    IMPORT_TIMEOUT,
  );
});

describe('publicPageMetadata', () => {
  it('suffixes the brand on social titles unless the title is absolute', () => {
    const base = { path: '/x', description: 'd', locale: 'pt-BR', imageAlt: 'a' };
    const page = publicPageMetadata({ ...base, title: 'Sign in' });
    expect(page.title).toBe('Sign in');
    expect(page.openGraph?.title).toBe('Sign in · PostMind Studio');
    expect((page.openGraph as { locale?: string }).locale).toBe('pt_BR');
    const home = publicPageMetadata({ ...base, title: 'PostMind Studio', absoluteTitle: true });
    expect(home.title).toEqual({ absolute: 'PostMind Studio' });
    expect(home.twitter?.title).toBe('PostMind Studio');
  });
});
