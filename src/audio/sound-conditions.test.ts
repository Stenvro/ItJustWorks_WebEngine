import { describe, expect, it } from 'vitest';
import type { Condition } from '../scripting/conditions.ts';
import { soundConditionsHold, type SoundConditionContext } from './sound-conditions.ts';

const condition = (
  fn: number,
  operator: number,
  comparand: number,
  or = false,
  form = 0,
): Condition => ({ function: fn, operator, comparand, or, form, param2: 0, strings: [] });

const day: SoundConditionContext = {
  hour: 10,
  weather: 0x10a241,
  raining: false,
  interior: false,
  swimming: false,
  global: (formId) => (formId === 0x10de1e ? 1 : 0),
};

describe('sound conditions', () => {
  it('reads the time of day, with OR groups (night: after 22 or before 5)', () => {
    const night = [condition(18, 3, 22, true), condition(18, 5, 5)];
    expect(soundConditionsHold(night, day)).toBe(false);
    expect(soundConditionsHold(night, { ...day, hour: 23 })).toBe(true);
    expect(soundConditionsHold(night, { ...day, hour: 3 })).toBe(true);
  });

  it('reads the weather, rain, interiors and swimming; others count as true', () => {
    expect(soundConditionsHold([condition(149, 0, 0, false, 0x10a241)], day)).toBe(false);
    expect(soundConditionsHold([condition(62, 0, 1)], { ...day, raining: true })).toBe(true);
    expect(soundConditionsHold([condition(300, 0, 0)], { ...day, interior: true })).toBe(false);
    expect(soundConditionsHold([condition(185, 4, 1)], day)).toBe(true);
    expect(soundConditionsHold([condition(69, 0, 1, false, 0x13746)], day)).toBe(true);
  });

  it('reads global variables, also as the comparand', () => {
    expect(soundConditionsHold([condition(74, 0, 1, false, 0x10de1e)], day)).toBe(true);
    expect(soundConditionsHold([condition(74, 0, 1, false, 0x10de1f)], day)).toBe(false);
    const against: Condition = { ...condition(18, 2, 0), comparand: { global: 0x10de1e } };
    expect(soundConditionsHold([against], day)).toBe(true);
  });
});
