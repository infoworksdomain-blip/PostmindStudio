'use client';

import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import { MAX_SCHEDULE_AHEAD_DAYS } from '@/lib/studio/schedule-window';
import { TARGET_DEFAULT_SEC as HOOK_DEMO_TARGET_SEC } from '@/lib/studio/formats/hook-demo';
import { buildTargets } from '../automation/automation';
import {
  BRIEF_MAX,
  CAROUSEL_POSTS_DEFAULT,
  EMPTY_WALL_OF_TEXT,
  HOOK_LINE_MAX_WORDS,
  MAX_BUDGET_POUNDS,
  publishPlatforms,
  usesTemplate,
  WALL_TEXT_MAX_WORDS,
  type CreateProblem,
} from './body';
import type { CreateForm } from './use-create-form';

// The Create screen's words that depend on the form: the options summary (separate facts joined
// with a middle dot — a list, not a sentence) and each validation problem's message.

const WHOLE_POUNDS: Intl.NumberFormatOptions = {
  style: 'currency',
  currency: 'GBP',
  maximumFractionDigits: 0,
};

export function useCreateText(c: CreateForm) {
  const t = useTranslations('create.screen');
  const tp = useTranslations('create.problems');
  const tl = useTranslations('create.options.lengths');
  const f = useFormat();
  const { form, state, publishable } = c;
  const isWall = form.source === 'WALL_OF_TEXT';
  const isFormat = form.source === 'HOOK_DEMO' || isWall;
  const templated = usesTemplate(state, c.reference);

  const problemText = (p: CreateProblem): string => {
    if (p === 'briefTooLong') return tp('briefTooLong', { max: BRIEF_MAX });
    if (p === 'autoPublishAccountRequired')
      return tp(p, {
        platforms: f.list(
          publishPlatforms(state)
            .filter((x) => publishable.includes(x))
            .map((x) => f.platform(x)),
          'disjunction',
        ),
      });
    if (p === 'autoPublishNoMatchingAccount')
      return tp(p, { platforms: f.list(publishable.map((x) => f.platform(x))) });
    if (p === 'scheduleTooFar') return tp('scheduleTooFar', { days: MAX_SCHEDULE_AHEAD_DAYS });
    if (p === 'hookLineTooLong') return tp('hookLineTooLong', { max: HOOK_LINE_MAX_WORDS });
    if (p === 'wallTextTooLong') return tp('wallTextTooLong', { max: WALL_TEXT_MAX_WORDS });
    if (p === 'budgetRange')
      return tp('budgetRange', {
        min: f.number(0, WHOLE_POUNDS),
        max: f.number(MAX_BUDGET_POUNDS, WHOLE_POUNDS),
      });
    return tp(p);
  };

  const length = isFormat
    ? t('summarySeconds', {
        // 22.1: up to 15 s (the demo may be shorter); 22.2: the chosen length.
        count: isWall
          ? (form.wallOfText?.durationSec ?? EMPTY_WALL_OF_TEXT.durationSec)
          : HOOK_DEMO_TARGET_SEC,
      })
    : tl(form.length);
  const posting = !c.data.connections.data
    ? null
    : !c.hasAccounts
      ? t('summaryNoAccounts')
      : state.autoPublish
        ? t('summaryAutoPublish', {
            count: buildTargets(publishPlatforms(state), c.accounts).length,
          })
        : t('summaryForReview');
  const summary: string[] = (
    form.source === 'CAROUSEL'
      ? [
          t('summaryCarousel', {
            count: form.carouselPosts ?? CAROUSEL_POSTS_DEFAULT,
            theme: form.carouselTheme ?? 'light',
          }),
          state.brandKitId ? t('summaryBrandKit') : null,
        ]
      : [
          templated && form.projectTemplate
            ? t('summaryTemplate', { name: form.projectTemplate.name })
            : `${t('summaryPlatforms', { count: state.platforms.length })} · ${length}`,
          posting,
          state.brandKitId ? t('summaryBrandKit') : null,
        ]
  ).filter((x): x is string => Boolean(x));

  return { summary, problemText, templated };
}
