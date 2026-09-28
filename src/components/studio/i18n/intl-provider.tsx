'use client';

import { IntlErrorCode, NextIntlClientProvider, type IntlError } from 'next-intl';
import { Direction } from 'radix-ui';
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { registerErrorCatalogue } from '@/lib/client/api';
import { ConfigurationError } from '@/lib/errors';
import { directionOf, localeCookieString, type Locale } from '@/lib/i18n/locales';
import type { Messages } from '@/lib/i18n/messages';

// BACKLOG 16.1 / 16.2 — the Studio's i18n context for Client Components: next-intl's
// NextIntlClientProvider (locale + that locale's catalogue; https://next-intl.dev/docs/usage/configuration
// — onError / getMessageFallback are not inherited from the server, so they are set here), radix's
// DirectionProvider (menus, popovers and sheets mirror in RTL) and the locale switch.
//
// In the app, src/app/layout.tsx (a Server Component) resolves the locale (src/i18n/request.ts)
// and passes the catalogue down; switching writes the studio.locale cookie and refreshes the
// server tree (onLocaleChange = router.refresh). The demo bundle passes every catalogue and
// switches in memory.

export type MissingKeyMode = 'warn' | 'throw';

interface LocaleSwitch {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const LocaleSwitchContext = createContext<LocaleSwitch | null>(null);

/** The active locale and the switch (language switcher, settings). */
export function useLocaleSwitch(): LocaleSwitch {
  const value = useContext(LocaleSwitchContext);
  if (!value)
    throw new ConfigurationError('useLocaleSwitch must be used inside StudioIntlProvider');
  return value;
}

function reportIntlError(mode: MissingKeyMode) {
  return (error: IntlError) => {
    // No timeZone is configured on purpose: Studio formats dates with Intl in the browser's zone
    // (src/lib/client/format.ts), so next-intl's environment-fallback notice is expected.
    if (error.code === IntlErrorCode.ENVIRONMENT_FALLBACK) return;
    if (mode === 'throw') throw error;
    // A missing or broken catalogue entry must be visible while screens are localised, without
    // breaking the page: the key path is rendered (getMessageFallback) and reported here.
    // eslint-disable-next-line no-console -- surfaces missing catalogue keys in the browser console
    console.warn(`[i18n] ${error.code}: ${error.message}`);
  };
}

function messageFallback({ namespace, key }: { namespace?: string; key: string }): string {
  return namespace ? `${namespace}.${key}` : key;
}

export function StudioIntlProvider({
  locale,
  messages,
  onLocaleChange,
  missingKeys = 'warn',
  syncDocument = true,
  children,
}: {
  locale: Locale;
  messages: Messages;
  /** After the cookie is written: the app refreshes the server tree, the demo swaps catalogues. */
  onLocaleChange?: (locale: Locale) => void;
  /** Tests throw on a missing key; the app and the demo warn and render the key path. */
  missingKeys?: MissingKeyMode;
  /** Keep <html lang dir> in step (off for the tests' outer default provider). */
  syncDocument?: boolean;
  children: ReactNode;
}) {
  const dir = directionOf(locale);
  // Plain (non-hook) callers such as toast.error(errorMessage(err)) read the active catalogue.
  registerErrorCatalogue(locale, messages.errors);

  useEffect(() => {
    // The server sets <html lang dir>; a client-side switch (and the demo) keeps it in step.
    if (!syncDocument) return;
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
  }, [locale, dir, syncDocument]);

  const setLocale = useCallback(
    (next: Locale) => {
      document.cookie = localeCookieString(next, window.location.protocol === 'https:');
      onLocaleChange?.(next);
    },
    [onLocaleChange],
  );
  const switchValue = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  const onError = useMemo(() => reportIntlError(missingKeys), [missingKeys]);

  return (
    <LocaleSwitchContext.Provider value={switchValue}>
      <NextIntlClientProvider
        locale={locale}
        messages={messages}
        onError={onError}
        getMessageFallback={messageFallback}
      >
        <Direction.DirectionProvider dir={dir}>{children}</Direction.DirectionProvider>
      </NextIntlClientProvider>
    </LocaleSwitchContext.Provider>
  );
}
