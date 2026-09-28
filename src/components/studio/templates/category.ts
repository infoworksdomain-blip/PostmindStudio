'use client';

import { useCallback } from 'react';
import { useLocale, useTranslations } from 'next-intl';

// BACKLOG 17.9 — template categories in the reader's language. Every category the built-in
// project and slideshow templates use (src/lib/studio/templates/seed.ts,
// src/lib/studio/slideshow/templates.ts), the default of a saved template ('custom') and the
// demo data has a catalogue label (templates.categories.<key>); a category an organisation typed
// itself is shown as stored, underscores as spaces.

export const TEMPLATE_CATEGORY_KEYS = [
  'custom',
  'introduction',
  'team_introduction',
  'product_showcase',
  'product_launch',
  'weekly_special',
  'behind_the_scenes',
  'before_after',
  'food',
  'lifestyle',
  'photo_dump',
  'quote_reel',
  'statistic_reel',
  'tweet_video',
  'listicle',
  'listicle_5',
  'listicle_10',
] as const;

export type TemplateCategoryKey = (typeof TEMPLATE_CATEGORY_KEYS)[number];

export function isTemplateCategoryKey(category: string): category is TemplateCategoryKey {
  return (TEMPLATE_CATEGORY_KEYS as readonly string[]).includes(category);
}

/**
 * Category → label. `capitalise` upper-cases the first letter in the reader's locale (a label
 * on its own line; catalogue labels are lower case to sit inside sentences).
 */
export function useTemplateCategory(): (category: string, capitalise?: boolean) => string {
  const t = useTranslations('templates.categories');
  const locale = useLocale();
  return useCallback(
    (category: string, capitalise = false) => {
      const label = isTemplateCategoryKey(category)
        ? t(category)
        : category.replace(/_/g, ' ').trim() || category;
      return capitalise ? label.charAt(0).toLocaleUpperCase(locale) + label.slice(1) : label;
    },
    [t, locale],
  );
}
