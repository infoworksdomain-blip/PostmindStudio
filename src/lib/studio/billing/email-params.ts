import { createTranslator } from 'next-intl';
import { DEFAULT_LOCALE, isLocale } from '../../i18n/locales';
import { loadMessages } from '../../i18n/messages';
import type { TopUpPack } from './catalogue';
import { PLAN_NAMES, PLAN_TIER, planOfSubscription } from './plans';

/** The product name (never translated, Phase 16 rule). */
export const PRODUCT_NAME = 'PostMind Studio';

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
 * The plan's name for emails ("Growth"). Plan names are product names, never translated (Phase 16
 * rule), taken from the subscription's lookup key (26.1 studio_<plan>_<interval>; a 21.5
 * studio_channel_<interval> price by its quantity) or, for older prices, its tier.
 */
export function planDisplayName(
  lookupKeyOrTier: string | null | undefined,
  quantity?: number | null,
): string | null {
  const raw = lookupKeyOrTier?.trim();
  if (!raw) return null;
  const plan = planOfSubscription({ lookupKey: raw, quantity });
  if (plan) return PLAN_NAMES[plan.plan];
  // The internal tier every plan maps to has no customer name: the product name.
  if (raw === PLAN_TIER) return PRODUCT_NAME;
  const tier = raw.startsWith('studio_') ? (raw.split('_')[1] ?? '') : raw;
  if (!tier) return null;
  return tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase();
}
