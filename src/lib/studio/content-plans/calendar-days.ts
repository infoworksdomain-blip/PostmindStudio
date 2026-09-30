// 20.9 — seasonal and UK calendar days a month plan can build a post around ("seasonal/UK
// calendar days" in the operator's request). Pure and deterministic: fixed dates, the movable
// feasts computed from Easter (anonymous Gregorian computus), and the UK bank holidays by rule.
// DECISION: a short, well-known list (UK public and retail days); the owner can add or remove
// items in the draft, so the list only has to suggest, never be complete.

export const CALENDAR_DAY_IDS = [
  'new_year',
  'valentines',
  'pancake_day',
  'st_davids',
  'st_patricks',
  'mothers_day_uk',
  'easter',
  'st_georges',
  'early_may_bank_holiday',
  'spring_bank_holiday',
  'fathers_day',
  'summer_bank_holiday',
  'halloween',
  'bonfire_night',
  'black_friday',
  'st_andrews',
  'small_business_saturday',
  'christmas_eve',
  'christmas',
  'boxing_day',
  'new_years_eve',
] as const;

export type CalendarDayId = (typeof CALENDAR_DAY_IDS)[number];

/** English names, used in the planning prompt (the UI translates the id). */
export const CALENDAR_DAY_NAMES: Readonly<Record<CalendarDayId, string>> = {
  new_year: "New Year's Day",
  valentines: "Valentine's Day",
  pancake_day: 'Pancake Day (Shrove Tuesday)',
  st_davids: "St David's Day",
  st_patricks: "St Patrick's Day",
  mothers_day_uk: "Mother's Day (UK)",
  easter: 'Easter Sunday',
  st_georges: "St George's Day",
  early_may_bank_holiday: 'Early May bank holiday',
  spring_bank_holiday: 'Spring bank holiday',
  fathers_day: "Father's Day",
  summer_bank_holiday: 'Summer bank holiday',
  halloween: 'Halloween',
  bonfire_night: 'Bonfire Night',
  black_friday: 'Black Friday',
  st_andrews: "St Andrew's Day",
  small_business_saturday: 'Small Business Saturday (UK)',
  christmas_eve: 'Christmas Eve',
  christmas: 'Christmas Day',
  boxing_day: 'Boxing Day',
  new_years_eve: "New Year's Eve",
};

/** A local calendar date (no time zone). */
export interface LocalDate {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
}

export interface CalendarDay {
  id: CalendarDayId;
  date: LocalDate;
}

const utc = (d: LocalDate) => Date.UTC(d.year, d.month - 1, d.day);
const fromUtc = (ms: number): LocalDate => {
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
};
const shift = (d: LocalDate, days: number) => fromUtc(utc(d) + days * 86_400_000);
const weekday = (d: LocalDate) => new Date(utc(d)).getUTCDay();

/** Easter Sunday (Gregorian), anonymous computus. */
export function easterSunday(year: number): LocalDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year, month, day };
}

/** The n-th (1-based) given weekday of a month; n = -1 is the last one. */
export function nthWeekday(year: number, month: number, dayOfWeek: number, n: number): LocalDate {
  if (n > 0) {
    const first = { year, month, day: 1 };
    const offset = (dayOfWeek - weekday(first) + 7) % 7;
    return shift(first, offset + (n - 1) * 7);
  }
  const last = fromUtc(Date.UTC(year, month, 0));
  const back = (weekday(last) - dayOfWeek + 7) % 7;
  return shift(last, -back);
}

/** Every calendar day of `year`, by date. */
export function calendarDaysOf(year: number): CalendarDay[] {
  const easter = easterSunday(year);
  const fixed = (id: CalendarDayId, month: number, day: number): CalendarDay => ({
    id,
    date: { year, month, day },
  });
  const days: CalendarDay[] = [
    fixed('new_year', 1, 1),
    fixed('valentines', 2, 14),
    { id: 'pancake_day', date: shift(easter, -47) },
    fixed('st_davids', 3, 1),
    fixed('st_patricks', 3, 17),
    { id: 'mothers_day_uk', date: shift(easter, -21) },
    { id: 'easter', date: easter },
    fixed('st_georges', 4, 23),
    { id: 'early_may_bank_holiday', date: nthWeekday(year, 5, 1, 1) },
    { id: 'spring_bank_holiday', date: nthWeekday(year, 5, 1, -1) },
    { id: 'fathers_day', date: nthWeekday(year, 6, 0, 3) },
    { id: 'summer_bank_holiday', date: nthWeekday(year, 8, 1, -1) },
    fixed('halloween', 10, 31),
    fixed('bonfire_night', 11, 5),
    // The Friday after the fourth Thursday of November.
    { id: 'black_friday', date: shift(nthWeekday(year, 11, 4, 4), 1) },
    fixed('st_andrews', 11, 30),
    { id: 'small_business_saturday', date: nthWeekday(year, 12, 6, 1) },
    fixed('christmas_eve', 12, 24),
    fixed('christmas', 12, 25),
    fixed('boxing_day', 12, 26),
    fixed('new_years_eve', 12, 31),
  ];
  return days.sort((x, y) => utc(x.date) - utc(y.date));
}

export function dateKey(d: LocalDate): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

/** Calendar days on local dates from `start` for `days` days (inclusive of start). */
export function calendarDaysBetween(start: LocalDate, days: number): CalendarDay[] {
  const from = utc(start);
  const to = from + days * 86_400_000;
  const years = new Set([start.year, fromUtc(to).year]);
  return [...years]
    .flatMap(calendarDaysOf)
    .filter((c) => utc(c.date) >= from && utc(c.date) < to)
    .sort((x, y) => utc(x.date) - utc(y.date));
}
