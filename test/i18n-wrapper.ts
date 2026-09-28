import { createElement, type ComponentType, type ReactNode } from 'react';
import { StudioIntlProvider } from '@/components/studio/i18n/intl-provider';
import { ALL_MESSAGES } from '@/lib/i18n/all-messages';
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n/locales';

// BACKLOG 16.1 — component tests render inside the Studio i18n provider. test/setup-dom.ts makes
// @testing-library/react's render/renderHook wrap every tree in the en-GB provider (missing keys
// throw, so a test fails on a key absent from the catalogue). A test that needs another locale
// renders `withLocale('ar', <Screen />)`: the nearest provider wins.

export function IntlTestProvider({
  locale = DEFAULT_LOCALE,
  syncDocument = true,
  children,
}: {
  locale?: Locale;
  syncDocument?: boolean;
  children?: ReactNode;
}) {
  // createElement in a .ts helper: StudioIntlProvider's children is a required prop.
  // eslint-disable-next-line react/no-children-prop
  return createElement(StudioIntlProvider, {
    locale,
    messages: ALL_MESSAGES[locale],
    missingKeys: 'throw',
    syncDocument,
    children,
  });
}

/** `render(withLocale('zh-Hans', <AppShell>…</AppShell>))`. */
export function withLocale(locale: Locale, ui: ReactNode) {
  return createElement(IntlTestProvider, { locale }, ui);
}

/** The en-GB provider around an optional caller-supplied wrapper. */
export function withIntlWrapper(
  Inner?: ComponentType<{ children: ReactNode }>,
): ComponentType<{ children: ReactNode }> {
  return function IntlWrapper({ children }: { children: ReactNode }) {
    return createElement(
      IntlTestProvider,
      { syncDocument: false },
      Inner ? createElement(Inner, null, children) : children,
    );
  };
}
