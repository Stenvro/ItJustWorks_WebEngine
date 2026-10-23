import { describe, expect, it } from 'vitest';
import {
  GRAB_DEFAULTS,
  invert3,
  maxRelativeForce,
  pointInverseMass,
  TELEKINESIS_DEFAULTS,
  TelekinesisHold,
} from './grab.ts';

describe('grab spring', () => {
  it('holds heavier objects more weakly: the high scale up to the low weight, the low beyond', () => {
    // The built-in values: 250 × 1 at 0 kg, × 0.6 at 150, × 0.2 at 300 and beyond.
    expect(maxRelativeForce(GRAB_DEFAULTS, 0)).toBeCloseTo(250);
    expect(maxRelativeForce(GRAB_DEFAULTS, 150)).toBeCloseTo(150);
    expect(maxRelativeForce(GRAB_DEFAULTS, 300)).toBeCloseTo(50);
    expect(maxRelativeForce(GRAB_DEFAULTS, 1000)).toBeCloseTo(50);
    // Skyrim.esm's: 100 up to 150 kg.
    const plugins = { ...GRAB_DEFAULTS, maxForce: 100, maxForceWeightHigh: 150 };
    expect(maxRelativeForce(plugins, 75)).toBeCloseTo(60);
    // Telekinesis: no weight scale.
    expect(maxRelativeForce(TELEKINESIS_DEFAULTS.spring, 500)).toBeCloseTo(1000);
  });

  it('builds the effective inverse mass at a point', () => {
    // Inverse inertia 2 about every axis, inverse mass 0.5, point one unit along x: pushing
    // along x moves only the centre; along y and z the body also turns.
    const k = pointInverseMass(0.5, [2, 0, 0, 2, 0, 2], [1, 0, 0]);
    expect(k).toEqual([0.5, 0, 0, 0, 2.5, 0, 0, 0, 2.5]);
    const inverse = invert3(k);
    expect(inverse?.[0]).toBeCloseTo(2);
    expect(inverse?.[4]).toBeCloseTo(0.4);
    expect(invert3([1, 2, 3, 2, 4, 6, 0, 0, 1])).toBeUndefined();
  });
});

describe('telekinesis', () => {
  it('pulls the object in at a gathering speed, holds it, and throws once it gathered', () => {
    const hold = new TelekinesisHold(TELEKINESIS_DEFAULTS, 1000);
    // Let go while still coming: it drops.
    hold.update(0.1);
    expect(hold.distance).toBeCloseTo(1000 - 90 * 0.1);
    expect(hold.throwSpeed(false)).toBe(0);
    for (let i = 0; i < 300; i++) hold.update(1 / 60);
    expect(hold.distance).toBe(TELEKINESIS_DEFAULTS.distanceMin);
    // Held a while: 1000 and what it gathered (10 a second, up to 30).
    for (let i = 0; i < 600; i++) hold.update(1 / 60);
    expect(hold.throwSpeed(false)).toBeCloseTo(1030, 0);
    expect(hold.throwSpeed(true)).toBeCloseTo(2060, 0);
  });
});
