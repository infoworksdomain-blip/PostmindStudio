import { isLocale, localeCookieString, type Locale } from '@/lib/i18n/locales';
import { DEMO_PLAN_PARAM, isBillingStateId, setBillingState } from './api/billing-state';
import { roleForPath, setViewerRole } from './api/viewer-role';
import { setLocationFilter } from './router';

// Tour links may carry `?demoPlan=<state>` (switch the demo's billing state) and `?lang=<locale>`
// (switch the interface language, saved like the header switcher saves it). The router applies
// them before any screen renders, then drops them from the address, so a reload or the back
// button does not apply them again and the screen never fetches with the previous state.

export const LANG_PARAM = 'lang';

let languageListener: ((locale: Locale) => void) | null = null;

/** DemoApp listens so a `?lang=` link swaps the catalogue in place. */
export function onLanguageParam(listener: (locale: Locale) => void): () => void {
  languageListener = listener;
  return () => {
    if (languageListener === listener) languageListener = null;
  };
}

export function installTourParams(): void {
  setLocationFilter((location) => {
    // 21.5: customers never see generation cost; the Admin Centre is viewed as staff.
    setViewerRole(roleForPath(location.pathname));
    const query = new URLSearchParams(location.search);
    const plan = query.get(DEMO_PLAN_PARAM);
    const lang = query.get(LANG_PARAM);
    if (plan === null && lang === null) return location;
    if (isBillingStateId(plan)) setBillingState(plan);
    if (lang !== null && isLocale(lang)) {
      document.cookie = localeCookieString(lang, window.location.protocol === 'https:');
      languageListener?.(lang);
    }
    query.delete(DEMO_PLAN_PARAM);
    query.delete(LANG_PARAM);
    const rest = query.toString();
    return { pathname: location.pathname, search: rest ? `?${rest}` : '' };
  });
}
