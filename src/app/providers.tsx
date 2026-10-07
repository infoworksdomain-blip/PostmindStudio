'use client';

import { useRouter } from 'next/navigation';
import { ThemeProvider } from 'next-themes';
import { useCallback, type ReactNode } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { BusinessProvider } from '@/components/studio/business-context';
import { StudioIntlProvider } from '@/components/studio/i18n/intl-provider';
import type { Locale } from '@/lib/i18n/locales';
import type { Messages } from '@/lib/i18n/messages';

export function Providers({
  locale,
  messages,
  children,
}: {
  locale: Locale;
  messages: Messages;
  children: ReactNode;
}) {
  const router = useRouter();
  // The language switcher has written the studio.locale cookie: re-render the server tree so the
  // layout picks the new locale, <html lang dir> and catalogue (no full page reload).
  const refresh = useCallback(() => router.refresh(), [router]);
  return (
    <StudioIntlProvider locale={locale} messages={messages} onLocaleChange={refresh}>
      {/* 25.2: Light / Dark / System; a new visitor follows their device. */}
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <TooltipProvider delayDuration={200}>
          <BusinessProvider>{children}</BusinessProvider>
          <Toaster richColors position="bottom-right" />
        </TooltipProvider>
      </ThemeProvider>
    </StudioIntlProvider>
  );
}
