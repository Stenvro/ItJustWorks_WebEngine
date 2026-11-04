import { describe, expect, it } from 'vitest';
import { burdenedRun, runWeightFactor, speedMultFactor } from './move-weight.ts';

describe('what slows a run', () => {
  it('takes a share of fMoveWeightMax (150) × fMoveEncumEffect (0.4) with a weapon drawn', () => {
    expect(runWeightFactor(0, true)).toBe(1);
    expect(runWeightFactor(75, true)).toBeCloseTo(0.8, 9);
    expect(runWeightFactor(150, true)).toBeCloseTo(0.6, 9);
  });

  it('takes fMoveEncumEffectNoWeapon (0.3) without, and no more past fMoveWeightMax', () => {
    expect(runWeightFactor(75, false)).toBeCloseTo(0.85, 9);
    expect(runWeightFactor(500, false)).toBeCloseTo(0.7, 9);
  });

  it('never slows a run below the walk', () => {
    expect(burdenedRun(300, 100, 0.8)).toBeCloseTo(240, 9);
    expect(burdenedRun(120, 100, 0.6)).toBe(100);
  });

  it('goes by the Speed Mult, 0 counting as 100 and a negative as its size', () => {
    expect(speedMultFactor(100)).toBe(1);
    expect(speedMultFactor(150)).toBe(1.5);
    expect(speedMultFactor(0)).toBe(1);
    expect(speedMultFactor(-50)).toBe(0.5);
  });
});
