import { describe, expect, it } from 'vitest';
import { fastTravelHours, noFastTravelReason } from './fast-travel.ts';

const free = { enabled: true, placeForbids: false, inAir: false, carried: 10, carryWeight: 300 };

describe('fast travel', () => {
  it('says why the player may not go', () => {
    expect(noFastTravelReason(free)).toBeUndefined();
    expect(noFastTravelReason({ ...free, enabled: false })).toBe('sNoFastTravelScriptBlock');
    expect(noFastTravelReason({ ...free, placeForbids: true })).toBe('sNoFastTravelCell');
    expect(noFastTravelReason({ ...free, inAir: true })).toBe('sNoFastTravelInAir');
    expect(noFastTravelReason({ ...free, carried: 301 })).toBe('sNoFastTravelOverencumbered');
    expect(noFastTravelReason({ ...free, takingHealthDamage: true })).toBe(
      'sFastTravelNoTravelHealthDamage',
    );
  });

  it('takes the time walking there takes, at the timescale', () => {
    // 72000 units at 80 a second: 900 s, twenty times faster on the game's clock: 5 hours.
    expect(fastTravelHours(72000, 80, 1, 20)).toBeCloseTo(5, 6);
    expect(fastTravelHours(72000, 80, 2, 20)).toBeCloseTo(2.5, 6);
    expect(fastTravelHours(0, 80, 1, 20)).toBe(0);
    expect(fastTravelHours(1000, 0, 1, 20)).toBe(0);
  });
});
