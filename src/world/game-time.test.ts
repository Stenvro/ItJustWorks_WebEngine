import { describe, expect, it } from 'vitest';
import { dateAfter, dayOfWeekAfter, DEFAULT_START_DATE } from './game-time.ts';

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
