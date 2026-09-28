import type enGB from '../../../messages/en-GB.json';
import { DEFAULT_LOCALE, type Locale } from './locales';

// BACKLOG 16.1 — message catalogues live in messages/<locale>.json (one per locale, keys grouped
// by screen namespace; en-GB is the source of truth — scripts/i18n/check-catalogues.ts keeps the
// others in step). The app loads only the active locale's catalogue on the server
// (src/i18n/request.ts); the demo bundle imports all of them statically (all-messages.ts).

/** The catalogue shape: en-GB's. Every locale has exactly these keys (the catalogue check). */
export type Messages = typeof enGB;

export type Namespace = keyof Messages;

// next-intl type augmentation (https://next-intl.dev/docs/workflows/typescript): message keys and
// the locale union are checked by tsc — `t('shell.nav.missing')` or `useTranslations('nope')` is
// a compile error, and useLocale() returns Locale.
declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}

/** Server-side loader for one catalogue (code-split per locale by the bundler). */
export async function loadMessages(locale: Locale): Promise<Messages> {
  switch (locale) {
    case 'en-GB':
      return (await import('../../../messages/en-GB.json')).default;
    case 'en-US':
      return (await import('../../../messages/en-US.json')).default;
    case 'fr':
      return (await import('../../../messages/fr.json')).default;
    case 'es':
      return (await import('../../../messages/es.json')).default;
    case 'ar':
      return (await import('../../../messages/ar.json')).default;
    case 'de':
      return (await import('../../../messages/de.json')).default;
    case 'it':
      return (await import('../../../messages/it.json')).default;
    case 'pt-BR':
      return (await import('../../../messages/pt-BR.json')).default;
    case 'pt-PT':
      return (await import('../../../messages/pt-PT.json')).default;
    case 'hi':
      return (await import('../../../messages/hi.json')).default;
    case 'zh-Hans':
      return (await import('../../../messages/zh-Hans.json')).default;
    default:
      return loadMessages(DEFAULT_LOCALE);
  }
}
