import { createTranslator } from 'next-intl';
import { DEFAULT_LOCALE, isLocale } from '../../i18n/locales';
import { loadMessages } from '../../i18n/messages';
import type { TopUpPack } from './catalogue';

// Params for the billing emails (src/emails/catalogue.ts: topupReceipt, trialEnding, …). The
// template renders them in the owner's locale, so a param that is itself words (a pack name) is
// built per owner from the same catalogue wording the pricing page uses.

/** "10 short videos" in the reader's language (pricing.topUps.short / long). */
export async function topUpPackName(
  pack: Pick<TopUpPack, 'kind' | 'quantity'>,
  locale: string,
): Promise<string> {
  const lang = isLocale(locale) ? locale : DEFAULT_LOCALE;
  const t = createTranslator({
    locale: lang,
    messages: await loadMessages(lang),
    namespace: 'pricing.topUps',
  });
  return t(pack.kind, { quantity: pack.quantity });
}

/**
 * The plan's product name for emails ("Standard"). Plan names are product names, never
 * translated (Phase 16 rule), taken from the subscription's tier or its lookup key
 * (studio_<tier>_<interval>).
 */
export function planDisplayName(tierOrLookupKey: string | null | undefined): string | null {
  const raw = tierOrLookupKey?.trim();
  if (!raw) return null;
  const tier = raw.startsWith('studio_') ? (raw.split('_')[1] ?? '') : raw;
  if (!tier) return null;
  return tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase();
}
