import { describe, expect, it } from 'vitest';
import {
  advanceSkill,
  experienceToLevel,
  levelFraction,
  levelThreshold,
  levelUpsWaiting,
  skillFraction,
  skillThreshold,
  skillUseExperience,
} from './progression.ts';

/** Lockpicking's AVSK (UESP "Leveling"). */
const LOCKPICKING = { useMult: 45, useOffset: 10, improveMult: 0.25, improveOffset: 300 };
const ONE_HANDED = { useMult: 6.3, useOffset: 0, improveMult: 2, improveOffset: 0 };

describe('skill experience', () => {
  it("follows UESP's example: Lockpicking 15 → 16 needs 0.25 × 15^1.95 + 300", () => {
    expect(skillThreshold(15, LOCKPICKING)).toBeCloseTo(349.13, 1);
  });

  it('gives use mult × use + use offset, more by the skill advance bonus', () => {
    expect(skillUseExperience(50, LOCKPICKING)).toBe(2260);
    expect(skillUseExperience(2, LOCKPICKING, 20)).toBeCloseTo(120);
    expect(skillUseExperience(0, LOCKPICKING)).toBe(0);
  });

  it('raises a skill several levels from one use, the rest kept', () => {
    const result = advanceSkill({ level: 15, experience: 0 }, 2260, LOCKPICKING);
    expect(result.reached).toEqual([16, 17, 18, 19, 20, 21]);
    expect(result.level).toBe(21);
    expect(result.experience).toBeGreaterThan(0);
    expect(result.experience).toBeLessThan(skillThreshold(21, LOCKPICKING));
  });

  it('stops at 100', () => {
    const result = advanceSkill({ level: 99, experience: 0 }, 1e9, ONE_HANDED);
    expect(result.level).toBe(100);
    expect(result.reached).toEqual([100]);
    expect(result.experience).toBe(0);
    expect(advanceSkill({ level: 100, experience: 0 }, 1e6, ONE_HANDED).reached).toEqual([]);
    expect(skillFraction({ level: 100, experience: 0 }, ONE_HANDED)).toBe(1);
  });

  it('shows the progress toward the next level', () => {
    const half = skillThreshold(30, ONE_HANDED) / 2;
    expect(skillFraction({ level: 30, experience: half }, ONE_HANDED)).toBeCloseTo(0.5);
  });
});

describe("the character's level", () => {
  it('needs fXPLevelUpBase + fXPLevelUpMult × level: (level + 3) × 25', () => {
    expect(levelThreshold(1)).toBe(100);
    expect(levelThreshold(10)).toBe(325);
  });

  it("totals UESP's 12.5 L² + 62.5 L − 75 from level 1", () => {
    for (const level of [1, 2, 10, 50, 81])
      expect(experienceToLevel(level)).toBe(12.5 * level * level + 62.5 * level - 75);
  });

  it('lets level-ups wait in a row, the meter full meanwhile', () => {
    expect(levelUpsWaiting(1, 99)).toBe(0);
    expect(levelUpsWaiting(1, 100)).toBe(1);
    expect(levelUpsWaiting(1, 225)).toBe(2);
    expect(levelFraction(1, 50)).toBe(0.5);
    expect(levelFraction(1, 300)).toBe(1);
  });
});
