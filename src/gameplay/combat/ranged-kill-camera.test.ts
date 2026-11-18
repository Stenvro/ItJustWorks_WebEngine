import { describe, expect, it } from 'vitest';
import {
  rangedKillCameraChance,
  rangedKillCameraPlays,
  aimedSpellKills,
  selfAreaKill,
  spellCameraRide,
  spellKill,
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

  it('kills at once by the whole magnitude, a concentration spell too; over time plays none  [original]', () => {
    // Flames: 8 a second, taken whole as its magnitude, not its spray's share.
    const flames = { immediate: 8, overTime: 0, longest: 0 };
    expect(aimedSpellKills(flames, 8)).toBe(true);
    expect(aimedSpellKills(flames, 9)).toBe(false);
    // A poison's damage over 10 s kills in time: no kill camera for an aimed cast.
    const poison = { immediate: 2, overTime: 20, longest: 10 };
    expect(spellKill(poison, 15)).toEqual({ kills: true, seconds: 10 });
    expect(aimedSpellKills(poison, 15)).toBe(false);
    // A ward held up takes its Ward Power off both.
    expect(aimedSpellKills({ immediate: 25, overTime: 0, longest: 0 }, 20, 10)).toBe(false);
    expect(spellKill({ immediate: 25, overTime: 0, longest: 0 }, 20, -5).kills).toBe(true);
  });

  it('weighs a self spell against all fighting the player: each must die, the nearest within 2500  [original]', () => {
    const near = { reference: 1, distance: 300, kills: true };
    const far = { reference: 2, distance: 900, kills: true };
    const lives = { reference: 3, distance: 600, kills: false };
    expect(selfAreaKill([far, near])).toBe(1);
    // One left standing: none, unless [VATS] bVATSAllowNoKill.
    expect(selfAreaKill([near, lives])).toBeUndefined();
    expect(selfAreaKill([lives, far], true)).toBe(3);
    // None within 2500 units: none.
    expect(selfAreaKill([{ reference: 4, distance: 2600, kills: true }])).toBeUndefined();
    expect(selfAreaKill([])).toBeUndefined();
  });
});
