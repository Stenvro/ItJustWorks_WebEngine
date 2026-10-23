import { describe, expect, it } from 'vitest';
import {
  LOCK_OPEN_ANGLE,
  lockDifficulty,
  lockLevelSetting,
  lockpickSettings,
  lockShape,
  lockTurnLimit,
} from './lockpicking.ts';

describe('lockpicking', () => {
  it('maps lock levels to difficulties and their names', () => {
    expect(lockDifficulty(1)).toBe(1);
    expect(lockDifficulty(25)).toBe(2);
    expect(lockDifficulty(50)).toBe(3);
    expect(lockDifficulty(75)).toBe(4);
    expect(lockDifficulty(100)).toBe(5);
    expect(lockDifficulty(255)).toBeUndefined();
    expect(lockLevelSetting(4)).toBe('sLockLevelNameHard');
    expect(lockLevelSetting(undefined)).toBe('sLockLevelNameImpossible');
  });

  it('sizes the sweet spot and the partial zones as UESP gives them', () => {
    // A Master lock at skill 100 without perks: 60 / 32 × 1.42 and 6 × 2.275 (UESP's table).
    const master = lockShape(5, 100, { random: 0.5 });
    expect(master.sweetSpot).toBeCloseTo(2.6625, 3);
    expect(master.partial).toBeCloseTo(13.65, 3);
    expect(master.breakSeconds).toBeCloseTo(0.375, 5);
    // A Novice lock at skill 0 with Novice Locks: 30 × 0.82 × 2.
    const novice = lockShape(1, 0, { perk: true, random: 0 });
    expect(novice.sweetSpot).toBeCloseTo(49.2, 3);
    expect(novice.center).toBeCloseTo(24.6, 3);
    expect(novice.breakSeconds).toBe(2);
  });

  it('takes its sizes and times from the settings by name', () => {
    const named: Record<string, number> = {
      fSweetSpotHard: 4,
      fLockpickBreakExpert: 1,
      fLockpickBreakSkillMult: 0.01,
      fLockpickBrokenPicksMult: 2,
    };
    const settings = lockpickSettings((name) => named[name]);
    expect(settings.sweetSpot).toEqual([30, 15, 7.5, 4, 1.875]);
    const hard = lockShape(4, 50, { random: 0, settings, brokenPicks: 3 });
    // 4 × (0.82 + 0.006 × 50) + 2 × 3; 1 × (1 + 0.01 × 50).
    expect(hard.sweetSpot).toBeCloseTo(4 * 1.12 + 6, 5);
    expect(hard.breakSeconds).toBeCloseTo(1.5, 5);
  });

  it('turns the lock fully in the sweet spot, partly beside it, not beyond', () => {
    const shape = { center: 90, sweetSpot: 10, partial: 20, breakSeconds: 1 };
    expect(lockTurnLimit(shape, 92)).toBe(LOCK_OPEN_ANGLE);
    expect(lockTurnLimit(shape, 105)).toBeCloseTo(LOCK_OPEN_ANGLE / 2, 5);
    expect(lockTurnLimit(shape, 60)).toBe(0);
  });
});
