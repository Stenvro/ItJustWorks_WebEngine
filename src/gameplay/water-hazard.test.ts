import { describe, expect, it } from 'vitest';
import { floatSpeed, submersion, swims, SWIM_SUBMERSION } from './swimming.ts';
import { SPELL_INTERVAL, WaterHazard } from './water-hazard.ts';

describe('water hazard', () => {
  it('takes damage per second and puts the spell on as one comes in, then each interval', () => {
    const hazard = new WaterHazard();
    const harm = { causesDamage: true, damagePerSecond: 10, spell: 0x123 };
    const first = hazard.step(1, harm, 0.5, 0.1);
    expect(first.damage).toBeCloseTo(1);
    expect(first.spell).toBe(0x123);
    expect(hazard.step(1, harm, 0.5, 0.1).spell).toBeUndefined();
    let spells = 0;
    for (let t = 0; t < SPELL_INTERVAL; t += 0.1)
      if (hazard.step(1, harm, 0.5, 0.1).spell) spells++;
    expect(spells).toBe(1);
    // Out and in again: a new entry.
    hazard.step(undefined, undefined, 0, 0.1);
    expect(hazard.step(1, harm, 0.5, 0.1).spell).toBe(0x123);
  });

  it('does nothing without the damage flag or out of the water', () => {
    const hazard = new WaterHazard();
    const harm = { causesDamage: false, damagePerSecond: 10, spell: undefined };
    expect(hazard.step(1, harm, 1, 1).damage).toBe(0);
    expect(hazard.step(1, { ...harm, causesDamage: true }, 0, 1).damage).toBe(0);
  });
});

describe('swimming', () => {
  it('swims from the shoulders, and floats to them at most at the swimming speed', () => {
    expect(submersion(0, 128, 100)).toBeCloseTo(100 / 128);
    expect(swims(SWIM_SUBMERSION, false)).toBe(true);
    expect(swims(SWIM_SUBMERSION - 0.02, false)).toBe(false);
    expect(swims(SWIM_SUBMERSION - 0.02, true)).toBe(true);
    // Feet 200 under the water of a 128 tall actor: it rises, at most at its speed.
    expect(floatSpeed(-200, 128, 0, 100, 1 / 60, false)).toBe(100);
    // Above its floating depth on the shore: the water does not pull it down.
    expect(floatSpeed(-10, 128, 0, 100, 1 / 60, true)).toBe(0);
  });
});
