import ar from '../../../messages/ar.json';
import de from '../../../messages/de.json';
import enGB from '../../../messages/en-GB.json';
import enUS from '../../../messages/en-US.json';
import es from '../../../messages/es.json';
import fr from '../../../messages/fr.json';
import hi from '../../../messages/hi.json';
import it from '../../../messages/it.json';
import ptBR from '../../../messages/pt-BR.json';
import ptPT from '../../../messages/pt-PT.json';
import zhHans from '../../../messages/zh-Hans.json';
import type { Locale } from './locales';
import type { Messages } from './messages';

// Every catalogue, imported statically: for the demo bundle (no server to load them per request,
// and the in-page language switcher changes locale without a reload) and for tests. The Next.js
// app never imports this module — it loads one catalogue per request (src/i18n/request.ts).

export const ALL_MESSAGES: Record<Locale, Messages> = {
  'en-GB': enGB,
  'en-US': enUS,
  fr,
  es,
  ar,
  de,
  it,
  'pt-BR': ptBR,
  'pt-PT': ptPT,
  hi,
  'zh-Hans': zhHans,
};
