import type { Metadata } from 'next';
import type { ReactNode } from 'react';
// Self-hosted fonts (no build-time call to Google Fonts). Two families (web performance rules):
// Instrument Serif for display, Inter for UI.
import '@fontsource-variable/inter';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'PostMind Studio', template: '%s · PostMind Studio' },
  description: 'AI video generation and multi-platform publishing for PostMind AI.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB" suppressHydrationWarning>
      <body className="font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
