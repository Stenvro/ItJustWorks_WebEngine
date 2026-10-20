import { describe, expect, it } from 'vitest';
import {
  bashCost,
  blockCost,
  powerAttackCost,
  regenPerSecond,
  spendDelay,
  sprintDrain,
} from './vitals.ts';

const base = { max: 200, rateMult: 100, inCombat: false };

describe('regeneration', () => {
  it("is the race's rate in % of the maximum a second", () => {
    expect(regenPerSecond(0, { ...base, rate: 0.7 })).toBeCloseTo(1.4);
    expect(regenPerSecond(1, { ...base, rate: 3 })).toBeCloseTo(6);
    expect(regenPerSecond(2, { ...base, rate: 5, rateMult: 150 })).toBeCloseTo(15);
  });

  it('slows in combat as UESP gives it (health none, magicka 0.99 %, stamina 1.75 %)', () => {
    const combat = { ...base, max: 100, inCombat: true };
    expect(regenPerSecond(0, { ...combat, rate: 0.7 })).toBe(0);
    expect(regenPerSecond(0, { ...combat, rate: 0.7, regenInCombat: true })).toBeCloseTo(0.7);
    expect(regenPerSecond(1, { ...combat, rate: 3 })).toBeCloseTo(0.99);
    expect(regenPerSecond(2, { ...combat, rate: 5 })).toBeCloseTo(1.75);
  });
});

describe('stamina', () => {
  it("waits UESP's way after spending more than there was, at most 5 s", () => {
    expect(spendDelay(80, 80, 10, 5)).toBe(0);
    expect(spendDelay(80, 60, 10, 5)).toBe(2);
    expect(spendDelay(80, 10, 10, 5)).toBe(5);
  });

  it('drains 7 a second sprinting, 2 % more a pound worn', () => {
    expect(sprintDrain(0)).toBe(7);
    expect(sprintDrain(50)).toBeCloseTo(14);
  });

  it('costs 40 + 2 × weight a power attack, 35 a bash, 55 a power bash', () => {
    expect(powerAttackCost(14)).toBe(68);
    expect(powerAttackCost(14, { dualWield: true })).toBe(102);
    expect(bashCost(false)).toBe(35);
    expect(bashCost(true)).toBe(55);
    expect(blockCost(40)).toBe(10);
  });
});
