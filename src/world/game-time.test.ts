import { describe, expect, it } from 'vitest';
import {
  clockPaceText,
  dateAfter,
  dayOfWeekAfter,
  DEFAULT_START_DATE,
  formatGameDate,
  nextClockSpeed,
} from './game-time.ts';

describe('game calendar', () => {
  it('counts days on through the months and into the next year', () => {
    expect(dateAfter(DEFAULT_START_DATE, 0)).toEqual({ year: 201, month: 7, day: 17 });
    // Last Seed has 31 days.
    expect(dateAfter(DEFAULT_START_DATE, 14)).toEqual({ year: 201, month: 7, day: 31 });
    expect(dateAfter(DEFAULT_START_DATE, 15)).toEqual({ year: 201, month: 8, day: 1 });
    expect(dateAfter({ year: 201, month: 11, day: 31 }, 1)).toEqual({
      year: 202,
      month: 0,
      day: 1,
    });
    expect(dateAfter({ year: 201, month: 1, day: 27 }, 2)).toEqual({ year: 201, month: 2, day: 1 });
  });

  it('starts on a Sundas and goes round the week', () => {
    expect(dayOfWeekAfter(0)).toBe(0);
    expect(dayOfWeekAfter(1)).toBe(1);
    expect(dayOfWeekAfter(7)).toBe(0);
    expect(dayOfWeekAfter(13)).toBe(6);
  });
});

describe('the clock fast-forward', () => {
  it('steps from the game pace through 2×, 5×, 10× and 20× back to the game pace', () => {
    const steps = [1];
    for (let i = 0; i < 5; i++) steps.push(nextClockSpeed(steps[steps.length - 1] ?? 1));
    expect(steps).toEqual([1, 2, 5, 10, 20, 1]);
  });

  it('tells how long a game day lasts', () => {
    expect(clockPaceText(20, 1)).toBe('TimeScale 20: a game day in 72 min');
    expect(clockPaceText(20, 20)).toBe('TimeScale 400: a game day in 3.6 min');
  });
});

describe('formatGameDate', () => {
  const names: Record<string, string> = {
    sDaySunday: 'Sundas',
    sDayMonday: 'Morndas',
    sMonthAugust: 'Last Seed',
    sMonthJanuary: 'Morning Star',
    sTimeAM: 'AM',
    sTimePM: 'PM',
    sOf: ' of ',
    sFirstOrdSuffix: 'st',
    sSecondOrdSuffix: 'nd',
    sThirdOrdSuffix: 'rd',
    sDefaultOrdSuffix: 'th',
  };
  const setting = (name: string): string | undefined => names[name];

  it('writes the date as the menus show it', () => {
    expect(formatGameDate(DEFAULT_START_DATE, 0, 19.2, setting)).toBe(
      'Sundas, 7:12 PM, 17th of Last Seed, 4E 201',
    );
    expect(formatGameDate({ year: 202, month: 0, day: 1 }, 1, 0.5, setting)).toBe(
      'Morndas, 12:30 AM, 1st of Morning Star, 4E 202',
    );
  });

  it('gives each day of the month its suffix', () => {
    const day = (n: number): string =>
      formatGameDate({ year: 201, month: 7, day: n }, 0, 12, setting).split(', ')[2] ?? '';
    expect([2, 3, 11, 12, 13, 21, 22, 23, 31].map(day)).toEqual([
      '2nd of Last Seed',
      '3rd of Last Seed',
      '11th of Last Seed',
      '12th of Last Seed',
      '13th of Last Seed',
      '21st of Last Seed',
      '22nd of Last Seed',
      '23rd of Last Seed',
      '31st of Last Seed',
    ]);
  });
});
