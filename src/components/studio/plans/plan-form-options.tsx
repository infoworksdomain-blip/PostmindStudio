'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChoiceChips } from '@/components/ui/choice-chips';
import { NativeSelect } from '@/components/ui/native-select';
import { useFormat } from '@/lib/client/format';
import type { PlatformConnection } from '@/lib/client/types';
import { UGC_VIDEO_ALLOWANCE_UNITS } from '@/lib/studio/ugc/allowance';
import { connectionsFor } from '../automation/automation';
import { PlatformChips } from '../create/create-options';
import { BusinessHashtagsNote } from '../hashtags/business-hashtags-panel';
import { Field } from '../review/field';
import type { PlanDefaults, PlanFormState } from './plan-model';

// BACKLOG 25.9 — the month planner's "More options", behind the one-click prompt: posts a day (or
// the business's posting times), the video / slideshow mix, UGC actors, platforms and the account
// each one posts to. Same fields and rules as 20.9 / 20.12 / 21.4; only where they sit changed.

const POSTS_PER_DAY = [1, 2, 3, 4] as const;
/** A posts-a-day count, or 'drip' for the business's own posting times. */
type PostsPerDayChoice = number | 'drip';

export interface PlanFormOptionsProps {
  form: PlanFormState;
  defaults: PlanDefaults;
  businessId: string;
  connections: readonly PlatformConnection[] | undefined;
  withAccounts: readonly string[];
  patch: (next: Partial<PlanFormState>) => void;
}

export function PlanFormOptions({
  form,
  defaults: d,
  businessId,
  connections,
  withAccounts,
  patch,
}: PlanFormOptionsProps) {
  const t = useTranslations('plans.new');
  const f = useFormat();
  const slideshows = 100 - form.videoShare;
  return (
    <div className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-2">
        <legend id="plan-posts-per-day" className="mb-1 text-xs font-medium text-muted-foreground">
          {t('postsPerDay')}
        </legend>
        <ChoiceChips<PostsPerDayChoice>
          type="single"
          aria-labelledby="plan-posts-per-day"
          value={form.useDripSlots ? 'drip' : form.postsPerDay}
          onChange={(v) =>
            patch(v === 'drip' ? { useDripSlots: true } : { postsPerDay: v, useDripSlots: false })
          }
          options={[
            ...POSTS_PER_DAY.map((n) => ({
              value: n,
              label: t('postsPerDayOption', { count: n }),
            })),
            { value: 'drip', label: t('useMyTimes'), disabled: !d.hasPostingTimes },
          ]}
        />
        <p className="text-xs text-muted-foreground">
          {d.hasPostingTimes
            ? t('useMyTimesHint', { count: d.postingTimesPerWeek })
            : t('noPostingTimes')}
        </p>
      </fieldset>

      <div className="flex flex-col gap-2">
        <label htmlFor="plan-mix" className="text-xs font-medium text-muted-foreground">
          {t('mix')}
        </label>
        <input
          id="plan-mix"
          type="range"
          min={0}
          max={100}
          step={5}
          value={form.videoShare}
          aria-valuetext={t('mixValue', { videos: form.videoShare, slideshows })}
          onChange={(e) => patch({ videoShare: Number(e.target.value) })}
          className="w-full accent-foreground"
        />
        <p className="tabular text-sm" aria-hidden>
          {t('mixValue', { videos: form.videoShare, slideshows })}
        </p>
        <p className="text-xs text-muted-foreground">{t('mixHint')}</p>
      </div>

      {/* 21.4: a plan's testimonial and product videos as UGC actor videos. */}
      {form.videoShare > 0 && (
        <div className="flex items-start gap-2">
          <input
            id="plan-ugc"
            type="checkbox"
            checked={Boolean(form.ugcActors)}
            onChange={(e) => patch({ ugcActors: e.target.checked })}
            aria-describedby="plan-ugc-hint"
            className="mt-0.5 size-4 accent-foreground"
          />
          <div className="flex flex-col gap-0.5">
            <label htmlFor="plan-ugc" className="text-sm">
              {t('ugcActors')}
            </label>
            <p id="plan-ugc-hint" className="text-xs text-muted-foreground">
              {t('ugcActorsHint', { count: UGC_VIDEO_ALLOWANCE_UNITS })}
            </p>
          </div>
        </div>
      )}

      <PlatformChips
        value={form.platforms}
        onChange={(next) => next.platforms && patch({ platforms: next.platforms })}
      />
      {/* 20.13: the hashtags every planned post carries (Business settings → Hashtags). */}
      <BusinessHashtagsNote businessId={businessId} />
      {withAccounts.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {withAccounts.map((platform) => {
            const options = connectionsFor(
              platform,
              connections ? [...connections] : undefined,
              businessId,
            );
            const id = `plan-account-${platform}`;
            return (
              <Field
                key={platform}
                id={id}
                label={t('account', { platform: f.platform(platform) })}
              >
                <NativeSelect
                  id={id}
                  value={form.accounts[platform] ?? ''}
                  onChange={(e) =>
                    patch({ accounts: { ...form.accounts, [platform]: e.target.value } })
                  }
                >
                  <option value="">{t('chooseAccount')}</option>
                  {options.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.platformAccountName}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 20.12: what happens to platforms without a connected account — with none at all the posts are
 * made and saved for review (nothing is scheduled); otherwise the uncovered platforms are made
 * but not posted.
 */
export function PlanAccountsNotice({
  platforms,
  withAccounts,
}: {
  platforms: readonly string[];
  withAccounts: readonly string[];
}) {
  const t = useTranslations('plans.new');
  const f = useFormat();
  const without = platforms.filter((p) => !withAccounts.includes(p));
  if (platforms.length === 0 || without.length === 0) return null;
  return (
    <p
      role="status"
      className="rounded-control border border-dashed border-border px-3 py-2 text-sm text-muted-foreground"
    >
      {withAccounts.length === 0
        ? t('noAccountsNotice')
        : t('someWithoutAccount', { platforms: f.list(without.map((p) => f.platform(p))) })}{' '}
      <Link href="/connections" className="text-foreground underline underline-offset-2">
        {t('connectAccount')}
      </Link>
    </p>
  );
}
