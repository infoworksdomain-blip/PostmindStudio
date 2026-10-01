'use client';

import { useId, useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
// the drip-queue panel owns the schedule. Native radios and checkboxes (arrow keys, labels).

const SELECT =
  'h-9 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50';
const LEGEND = 'mb-1.5 text-sm font-medium';
const HINT = 'text-xs text-muted-foreground';

function Pill({
  name,
  checked,
  onSelect,
  disabled,
  children,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        'cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring',
        checked
          ? 'border-foreground bg-secondary'
          : 'border-border text-muted-foreground hover:text-foreground',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <input
        type="radio"
        name={name}
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
      />
      {children}
    </label>
  );
}

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
        <legend className={LEGEND}>{t('howOften')}</legend>
        <div className="flex flex-wrap gap-2">
          <Pill
            name={`${id}-mode`}
            checked={s.mode === 'daily'}
            onSelect={() => onChange(setMode(s, 'daily'))}
          >
            {t('modeDaily')}
          </Pill>
          <Pill
            name={`${id}-mode`}
            checked={s.mode === 'weekly'}
            onSelect={() => onChange(setMode(s, 'weekly'))}
          >
            {t('modeWeekly')}
          </Pill>
        </div>
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
                <select
                  id={`${id}-per-day`}
                  className={cn(SELECT, 'w-24')}
                  value={s.postsPerDay}
                  disabled={disabled}
                  onChange={(e) => onChange(setPostsPerDay(s, Number(e.target.value)))}
                >
                  {Array.from({ length: MAX_POSTS_PER_DAY }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {f.count(n)}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <label htmlFor={`${id}-per-week`} className="text-sm font-medium">
                  {t('postsPerWeek')}
                </label>
                <select
                  id={`${id}-per-week`}
                  className={cn(SELECT, 'w-24')}
                  value={s.postsPerWeek}
                  disabled={disabled}
                  onChange={(e) => onChange(setPostsPerWeek(s, Number(e.target.value)))}
                >
                  {Array.from({ length: MAX_POSTS_PER_WEEK }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {f.count(n)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <p className={cn(HINT, 'pb-2')}>{t('maxPerDay', { max: MAX_POSTS_PER_DAY })}</p>
          </div>

          <fieldset disabled={disabled}>
            <legend className={LEGEND}>{t('days')}</legend>
            <div className="flex flex-wrap gap-1.5">
              {WEEK_ORDER.map((d) => {
                const on = s.days.includes(d);
                return (
                  <label
                    key={d}
                    className={cn(
                      'min-w-12 cursor-pointer rounded-lg border px-2.5 py-1.5 text-center text-sm transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring',
                      on
                        ? 'border-foreground bg-secondary'
                        : 'border-border text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={on}
                      aria-label={long[d]}
                      onChange={() => onChange(toggleDay(s, d))}
                    />
                    <span aria-hidden>{short[d]}</span>
                  </label>
                );
              })}
            </div>
            <p className={cn(HINT, 'mt-1.5')}>
              {s.mode === 'daily' ? t('daysHintDaily') : t('daysHintWeekly')}
            </p>
          </fieldset>

          <fieldset disabled={disabled}>
            <legend className={LEGEND}>{t('times')}</legend>
            <div className="flex flex-wrap gap-2">
              <Pill
                name={`${id}-times`}
                checked={s.timesMode === 'system'}
                onSelect={() => onChange(setTimesMode(s, 'system'))}
              >
                {t('timesSystem')}
              </Pill>
              <Pill
                name={`${id}-times`}
                checked={s.timesMode === 'choose'}
                onSelect={() => onChange(setTimesMode(s, 'choose'))}
              >
                {t('timesChoose')}
              </Pill>
              <Pill
                name={`${id}-times`}
                checked={s.timesMode === 'interval'}
                onSelect={() => onChange(setTimesMode(s, 'interval'))}
              >
                {t('timesInterval')}
              </Pill>
            </div>

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
                  <div
                    role="radiogroup"
                    aria-label={t('intervalHow')}
                    className="flex flex-wrap gap-2"
                  >
                    <Pill
                      name={`${id}-interval`}
                      checked={s.intervalBy === 'user'}
                      onSelect={() => onChange({ ...s, intervalBy: 'user' })}
                    >
                      {t('intervalUser')}
                    </Pill>
                    <Pill
                      name={`${id}-interval`}
                      checked={s.intervalBy === 'system'}
                      onSelect={() => onChange({ ...s, intervalBy: 'system' })}
                    >
                      {t('intervalSystem')}
                    </Pill>
                  </div>
                  {s.intervalBy === 'user' ? (
                    <div className="flex flex-wrap gap-3">
                      <div className="flex flex-col gap-1">
                        <label htmlFor={`${id}-every`} className={HINT}>
                          {t('every')}
                        </label>
                        <select
                          id={`${id}-every`}
                          className={SELECT}
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
                        </select>
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
        <select
          id={`${id}-zone`}
          className={cn(SELECT, 'w-full max-w-xs')}
          value={s.timezone}
          disabled={disabled}
          onChange={(e) => onChange({ ...s, timezone: e.target.value })}
        >
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
