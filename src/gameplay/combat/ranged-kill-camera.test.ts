import { describe, expect, it } from 'vitest';
import { rangedKillCameraChance, rangedKillCameraPlays } from './ranged-kill-camera.ts';

const settings = {
  longDistance: 2500,
  lowHealthPercent: 5,
  percentMin: 50,
  percentSneakKill: 20,
  percentTargetNoThreat: 10,
  targetLowLevelMult: 0.3,
};

const shot = {
  distance: 500,
  playerLevel: 10,
  targetLevel: 8,
  playerHealth: 1,
  sneakKill: false,
  threat: true,
};

describe('rangedKillCameraChance', () => {
  it('is the minimum near a threatening target', () => {
    expect(rangedKillCameraChance(shot, settings)).toBe(50);
  });

  it('grows with the distance', () => {
    expect(rangedKillCameraChance({ ...shot, distance: 2000 }, settings)).toBe(80);
  });

  it('always plays from the long distance, above the level, or low on health', () => {
    expect(rangedKillCameraChance({ ...shot, distance: 2500 }, settings)).toBe(100);
    expect(rangedKillCameraChance({ ...shot, targetLevel: 11 }, settings)).toBe(100);
    expect(rangedKillCameraChance({ ...shot, playerHealth: 0.04 }, settings)).toBe(100);
  });

  it('takes off the sneak kill, the no-threat and the low-level reductions', () => {
    expect(rangedKillCameraChance({ ...shot, sneakKill: true }, settings)).toBe(30);
    expect(rangedKillCameraChance({ ...shot, threat: false }, settings)).toBe(40);
    expect(rangedKillCameraChance({ ...shot, targetLevel: 2 }, settings)).toBe(40);
    expect(rangedKillCameraChance({ ...shot, threat: false, targetLevel: 2 }, settings)).toBe(30);
  });

  it('rolls under the chance', () => {
    expect(rangedKillCameraPlays(shot, settings, 50)).toBe(true);
    expect(rangedKillCameraPlays(shot, settings, 50.5)).toBe(false);
  });
});
