// The game's clock and calendar: how many game seconds pass per real second, and the date a
// new game starts on (the GameYear, GameMonth and GameDay globals: 17 Last Seed 4E 201), which
// UESP gives as a Sundas; the days of the week follow on from it.

import type { RecordDatabase } from './record-db.ts';

/** Skyrim.esm's TimeScale (GLOB): one real minute is twenty game minutes. */
export const DEFAULT_TIME_SCALE = 20;

/** Days in each month, Morning Star to Evening Star (UESP: as the Gregorian ones). */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
/** The day of the week a new game starts on (0 Sundas .. 6 Loredas). */
export const START_DAY_OF_WEEK = 0;

/** A date: the year of the era, the month (0: Morning Star) and the day (from 1). */
export interface GameDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Skyrim.esm's start date (GameYear 201, GameMonth 7: Last Seed, GameDay 17). */
export const DEFAULT_START_DATE: GameDate = { year: 201, month: 7, day: 17 };

/** The dev panel's fast-forward steps of the game clock; the first is the game's own pace. */
export const CLOCK_SPEEDS: readonly number[] = [1, 2, 5, 10, 20];

/** The next fast-forward step (after the last, the game's own pace again). */
export function nextClockSpeed(speed: number): number {
  const at = CLOCK_SPEEDS.indexOf(speed);
  return CLOCK_SPEEDS[(at + 1) % CLOCK_SPEEDS.length] ?? 1;
}

/**
 * The clock's pace for the panel: game time (the sun, moons, clouds, the sky's colours and what
 * follows the hour); animations (fire, water, trees, people) run in real time, as in the game.
 */
export function clockPaceText(timeScale: number, speed: number): string {
  const rate = timeScale * speed;
  const day = 1440 / rate;
  const minutes = day >= 10 ? String(Math.round(day)) : day.toFixed(1);
  return `TimeScale ${String(rate)}: a game day in ${minutes} min`;
}

/** The global TimeScale of the load order (game seconds per real second). */
export async function readTimeScale(db: RecordDatabase): Promise<number> {
  const value = (await readGlobals(db, ['timescale'])).get('timescale');
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : DEFAULT_TIME_SCALE;
}

/** The date a new game starts on (the GameYear, GameMonth and GameDay globals). */
export async function readStartDate(db: RecordDatabase): Promise<GameDate> {
  const values = await readGlobals(db, ['gameyear', 'gamemonth', 'gameday']);
  const whole = (name: string, fallback: number): number => {
    const value = values.get(name);
    return value !== undefined && Number.isFinite(value) ? Math.round(value) : fallback;
  };
  return {
    year: whole('gameyear', DEFAULT_START_DATE.year),
    month: whole('gamemonth', DEFAULT_START_DATE.month),
    day: whole('gameday', DEFAULT_START_DATE.day),
  };
}

/** The date `days` whole days after `start`. */
export function dateAfter(start: GameDate, days: number): GameDate {
  let { year, month, day } = start;
  for (let left = Math.max(0, Math.floor(days)); left > 0;) {
    const length = MONTH_DAYS[month] ?? 30;
    const rest = length - day;
    if (left <= rest) {
      day += left;
      break;
    }
    left -= rest + 1;
    day = 1;
    month++;
    if (month >= MONTH_DAYS.length) {
      month = 0;
      year++;
    }
  }
  return { year, month, day };
}

/** Whole days from `start` to `date` (negative before it). */
export function daysBetween(start: GameDate, date: GameDate): number {
  const ordinal = (d: GameDate): number => {
    let total = d.year * 365 + d.day;
    for (let month = 0; month < d.month; month++) total += MONTH_DAYS[month] ?? 30;
    return total;
  };
  return ordinal(date) - ordinal(start);
}

/** The day of the week `days` whole days after a new game's start (0 Sundas .. 6 Loredas). */
export const dayOfWeekAfter = (days: number): number =>
  (START_DAY_OF_WEEK + (Math.max(0, Math.floor(days)) % 7)) % 7;

/** Global values (FLTV) by lower-case editor id. */
export async function readGlobals(
  db: RecordDatabase,
  names: readonly string[],
): Promise<Map<string, number>> {
  const wanted = new Set(names);
  const values = new Map<string, number>();
  for (const formId of db.formIdsOfType('GLOB')) {
    const record = await db.get(formId);
    const name = record?.editorId?.toLowerCase();
    if (!record || record.deleted || name === undefined || !wanted.has(name)) continue;
    const value = record.fields.f32('FLTV');
    if (value !== undefined) values.set(name, value);
  }
  return values;
}
