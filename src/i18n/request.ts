import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { LOCALE_COOKIE, resolveLocale } from '@/lib/i18n/locales';
import { loadMessages } from '@/lib/i18n/messages';

// BACKLOG 16.1 — next-intl request configuration, "without i18n routing": Studio's URLs carry no
// locale prefix, so the locale comes from the request instead
// (https://next-intl.dev/docs/getting-started/app-router/without-i18n-routing — "you can call
// functions like cookies() and headers() to return configuration that is request-specific").
// Order: the user's explicit choice (studio.locale cookie, set by the language switcher), then
// Accept-Language negotiated against the supported locales, then en-GB. The next-intl plugin in
// next.config.ts points at this file. next-intl is pinned (4.14.7) in package.json.

export default getRequestConfig(async () => {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);
  const locale = resolveLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerList.get('accept-language'),
  });
  return { locale, messages: await loadMessages(locale) };
});
