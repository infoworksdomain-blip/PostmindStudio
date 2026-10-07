'use client';

import { useId, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { ChoiceChips } from '@/components/ui/choice-chips';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { useFormat } from '@/lib/client/format';
import {
  INTERVAL_CHOICES,
  MAX_POSTS_PER_DAY,
  MAX_POSTS_PER_WEEK,
  MIN_POST_GAP_MINUTES,
  WEEK_ORDER,
  maxPostsPerDay,
  scheduleProblems,
  timesForDay,
  type PostingSchedule,
} from '@/lib/studio/posting-schedule';
import { cn } from '@/lib/utils';
import { weekdayNames } from './month';
import {
  intervalParts,
  setMode,
  setPostsPerDay,
  setPostsPerWeek,
  setTime,
  setTimesMode,
  timeZones,
  toggleDay,
} from './schedule-model';

// 20.14 — the posting-schedule editor: Every day (1–4 posts a day) or N posts a week on chosen
// days, with times the owner picks, the system picks, or at intervals; time zone. Controlled:
// the drip-queue panel owns the schedule. 25.3: segmented controls and day chips (roving focus).

const LEGEND = 'mb-1.5 text-sm font-medium';
const HINT = 'text-xs text-muted-foreground';

export function PostingScheduleEditor({
  schedule,
  onChange,
  disabled = false,
}: {
  schedule: PostingSchedule;
  onChange: (next: PostingSchedule) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('calendar.drip.schedule');
  const f = useFormat();
  const id = useId();
  const short = useMemo(() => weekdayNames(f.locale, 'short'), [f.locale]);
  const long = useMemo(() => weekdayNames(f.locale, 'long'), [f.locale]);
  const zones = useMemo(() => timeZones(schedule.timezone), [schedule.timezone]);
  const s = schedule;
  const max = s.mode === 'custom' ? 1 : maxPostsPerDay(s);
  const valid = s.mode !== 'custom' && scheduleProblems(s).length === 0;
  const duration = (minutes: number) => {
    const p = intervalParts(minutes);
    return p.minutes === 0
      ? t('hours', { count: p.hours })
      : p.hours === 0
        ? t('minutes', { count: p.minutes })
        : t('hoursMinutes', { hours: p.hours, minutes: p.minutes });
  };

  return (
    <div className="flex flex-col gap-4">
      <fieldset disabled={disabled}>
        <legend id={`${id}-mode-legend`} className={LEGEND}>
          {t('howOften')}
        </legend>
        <SegmentedControl<PostingSchedule['mode']>
          aria-labelledby={`${id}-mode-legend`}
          value={s.mode}
          disabled={disabled}
          onChange={(mode) => {
            if (mode !== 'custom') onChange(setMode(s, mode));
          }}
          options={[
            { value: 'daily', label: t('modeDaily') },
            { value: 'weekly', label: t('modeWeekly') },
          ]}
        />
        {s.mode === 'custom' && <p className={cn(HINT, 'mt-1.5')}>{t('customNotice')}</p>}
      </fieldset>

      {s.mode !== 'custom' && (
        <>
          <div className="flex flex-wrap items-end gap-4">
            {s.mode === 'daily' ? (
              <div className="flex flex-col gap-1">
                <label htmlFor={`${id}-per-day`} className="text-sm font-medium">
                  {t('postsPerDay')}
                </label>
                <NativeSelect
                  id={`${id}-per-day`}
                  wrapperClassName="w-24"
                  value={s.postsPerDay}
                  disabled={disabled}
                  onChange={(e) => onChange(setPostsPerDay(s, Number(e.target.value)))}
                >
                  {Array.from({ length: MAX_POSTS_PER_DAY }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {f.count(n)}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <label htmlFor={`${id}-per-week`} className="text-sm font-medium">
                  {t('postsPerWeek')}
                </label>
                <NativeSelect
                  id={`${id}-per-week`}
                  wrapperClassName="w-24"
                  value={s.postsPerWeek}
                  disabled={disabled}
                  onChange={(e) => onChange(setPostsPerWeek(s, Number(e.target.value)))}
                >
                  {Array.from({ length: MAX_POSTS_PER_WEEK }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {f.count(n)}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
            <p className={cn(HINT, 'pb-2')}>{t('maxPerDay', { max: MAX_POSTS_PER_DAY })}</p>
          </div>

          <fieldset disabled={disabled}>
            <legend id={`${id}-days-legend`} className={LEGEND}>
              {t('days')}
            </legend>
            <ChoiceChips<number>
              type="multiple"
              aria-labelledby={`${id}-days-legend`}
              value={s.days}
              disabled={disabled}
              onChange={(next) => {
                const day = WEEK_ORDER.find((d) => next.includes(d) !== s.days.includes(d));
                if (day !== undefined) onChange(toggleDay(s, day));
              }}
              options={WEEK_ORDER.map((d) => ({
                value: d,
                label: (
                  <>
                    <span aria-hidden>{short[d]}</span>
                    <span className="sr-only">{long[d]}</span>
                  </>
                ),
              }))}
            />
            <p className={cn(HINT, 'mt-1.5')}>
              {s.mode === 'daily' ? t('daysHintDaily') : t('daysHintWeekly')}
            </p>
          </fieldset>

          <fieldset disabled={disabled}>
            <legend id={`${id}-times-legend`} className={LEGEND}>
              {t('times')}
            </legend>
            <SegmentedControl<PostingSchedule['timesMode']>
              aria-labelledby={`${id}-times-legend`}
              value={s.timesMode}
              disabled={disabled}
              onChange={(mode) => onChange(setTimesMode(s, mode))}
              className="flex-wrap"
              options={[
                { value: 'system', label: t('timesSystem') },
                { value: 'choose', label: t('timesChoose') },
                { value: 'interval', label: t('timesInterval') },
              ]}
            />

            <div className="mt-3 flex flex-col gap-2">
              {s.timesMode === 'system' && (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm">
                    {valid
                      ? t('timesLine', { times: f.list(timesForDay(s, max)) })
                      : t('systemHint')}
                  </p>
                  {valid && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => onChange(setTimesMode(s, 'choose'))}
                    >
                      {t('changeTimes')}
                    </Button>
                  )}
                </div>
              )}

              {s.timesMode === 'choose' && (
                <>
                  <div className="flex flex-wrap gap-3">
                    {s.times.map((time, i) => (
                      <div key={i} className="flex flex-col gap-1">
                        <label htmlFor={`${id}-time-${i}`} className={HINT}>
                          {t('postTime', { n: i + 1 })}
                        </label>
                        <Input
                          id={`${id}-time-${i}`}
                          type="time"
                          className="w-32"
                          value={time}
                          required
                          onChange={(e) => onChange(setTime(s, i, e.target.value))}
                        />
                      </div>
                    ))}
                  </div>
                  <p className={HINT}>{t('chooseHint', { minutes: MIN_POST_GAP_MINUTES })}</p>
                </>
              )}

              {s.timesMode === 'interval' && (
                <>
                  <SegmentedControl<PostingSchedule['intervalBy']>
                    label={t('intervalHow')}
                    value={s.intervalBy}
                    disabled={disabled}
                    onChange={(intervalBy) => onChange({ ...s, intervalBy })}
                    className="w-fit flex-wrap"
                    options={[
                      { value: 'user', label: t('intervalUser') },
                      { value: 'system', label: t('intervalSystem') },
                    ]}
                  />
                  {s.intervalBy === 'user' ? (
                    <div className="flex flex-wrap gap-3">
                      <div className="flex flex-col gap-1">
                        <label htmlFor={`${id}-every`} className={HINT}>
                          {t('every')}
                        </label>
                        <NativeSelect
                          id={`${id}-every`}
                          wrapperClassName="w-auto min-w-32"
                          value={s.intervalMinutes}
                          onChange={(e) =>
                            onChange({ ...s, intervalMinutes: Number(e.target.value) })
                          }
                        >
                          {INTERVAL_CHOICES.map((m) => (
                            <option key={m} value={m}>
                              {duration(m)}
                            </option>
                          ))}
                        </NativeSelect>
                      </div>
                      <div className="flex flex-col gap-1">
                        <label htmlFor={`${id}-start`} className={HINT}>
                          {t('startAt')}
                        </label>
                        <Input
                          id={`${id}-start`}
                          type="time"
                          className="w-32"
                          value={s.intervalStart}
                          required
                          onChange={(e) => onChange({ ...s, intervalStart: e.target.value })}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-3">
                      <div className="flex flex-col gap-1">
                        <label htmlFor={`${id}-from`} className={HINT}>
                          {t('windowStart')}
                        </label>
                        <Input
                          id={`${id}-from`}
                          type="time"
                          className="w-32"
                          value={s.windowStart}
                          required
                          onChange={(e) => onChange({ ...s, windowStart: e.target.value })}
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label htmlFor={`${id}-until`} className={HINT}>
                          {t('windowEnd')}
                        </label>
                        <Input
                          id={`${id}-until`}
                          type="time"
                          className="w-32"
                          value={s.windowEnd}
                          required
                          onChange={(e) => onChange({ ...s, windowEnd: e.target.value })}
                        />
                      </div>
                    </div>
                  )}
                  {valid && (
                    <p className="text-sm">
                      {t('timesLine', { times: f.list(timesForDay(s, max)) })}
                    </p>
                  )}
                </>
              )}
            </div>
          </fieldset>
        </>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-zone`} className="text-sm font-medium">
          {t('timezone')}
        </label>
        <NativeSelect
          id={`${id}-zone`}
          wrapperClassName="max-w-xs"
          value={s.timezone}
          disabled={disabled}
          onChange={(e) => onChange({ ...s, timezone: e.target.value })}
        >
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </NativeSelect>
      </div>
    </div>
  );
}
