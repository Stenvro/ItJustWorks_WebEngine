import { describe, expect, it } from 'vitest';
import {
  rangedKillCameraChance,
  rangedKillCameraPlays,
  selfAreaKill,
  spellCameraRide,
  spellLoosedDamage,
} from './ranged-kill-camera.ts';

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

describe('the magic kill camera', () => {
  it('rides a missile or lobber in flight, a flame its spray, a beam or cone nothing', () => {
    expect(spellCameraRide('flying')).toBe('flight');
    expect(spellCameraRide('lobber')).toBe('flight');
    expect(spellCameraRide('spray')).toBe('spray');
    expect(spellCameraRide('instant')).toBe('none');
    expect(spellCameraRide('cone')).toBe('none');
  });

  it("predicts a concentration spray by its interval's share, any other cast whole", () => {
    // Flames: 8 a second; a spray every 0.25 s carries 2.
    expect(spellLoosedDamage(8, 0.25)).toBe(2);
    expect(spellLoosedDamage(25, undefined)).toBe(25);
  });

  it("takes the nearest a self spell's area is predicted to kill, not an essential one", () => {
    const near = { reference: 1, distance: 300, damage: 225, health: 400, essential: false };
    const killed = { reference: 2, distance: 900, damage: 175, health: 150, essential: false };
    const nearer = { reference: 3, distance: 600, damage: 175, health: 100, essential: false };
    const essential = { reference: 4, distance: 100, damage: 225, health: 50, essential: true };
    expect(selfAreaKill([near, killed, nearer, essential])).toBe(3);
    expect(selfAreaKill([near, essential])).toBeUndefined();
  });
});
