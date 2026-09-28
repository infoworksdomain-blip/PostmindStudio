import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getLocale, getMessages } from 'next-intl/server';
// Self-hosted fonts (no build-time call to Google Fonts). Two families (web performance rules):
// Instrument Serif for display, Inter for UI.
import '@fontsource-variable/inter';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import { directionOf } from '@/lib/i18n/locales';
import type { Messages } from '@/lib/i18n/messages';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'PostMind Studio', template: '%s · PostMind Studio' },
  description: 'AI video generation and multi-platform publishing for PostMind AI.',
};

// BACKLOG 16.1 / 16.2 — the request's locale (src/i18n/request.ts: studio.locale cookie →
// Accept-Language → en-GB) sets <html lang dir>, and its catalogue is handed to the client
// provider (https://next-intl.dev/docs/getting-started/app-router/without-i18n-routing).
export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, messages] = await Promise.all([getLocale(), getMessages()]);
  return (
    <html lang={locale} dir={directionOf(locale)} suppressHydrationWarning>
      <body className="font-sans">
        <Providers locale={locale} messages={messages as Messages}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
