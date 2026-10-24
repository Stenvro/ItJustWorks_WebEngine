// Conformance: kill moves and the kill camera (engine map: Combat > Kill moves).
//
// Sources: the engine's defaults (fKillMoveMaxDuration 10 s, fCombatKillMoveDamageMult 10,
// fKillCamBaseOdds 0.1, fKillCamLevelBias 0.01, …LevelMaxBias 0.1, …LevelFactor 0.5); the
// ranged kill camera's odds, observed in the original ([VATS] fVATSRanged*: docs/gameplay.md).

import { describe, expect, it } from 'vitest';
import { COMBAT_DEFAULTS } from '../../../src/gameplay/combat/combat-settings.ts';
import { rangedKillCameraChance } from '../../../src/gameplay/combat/ranged-kill-camera.ts';
import { ENGINE } from './settings.ts';

const vats = {
  longDistance: 2000,
  lowHealthPercent: 20,
  percentMin: 10,
  percentSneakKill: 10,
  percentTargetNoThreat: 10,
  targetLowLevelMult: 0.5,
};
const shot = {
  distance: 500,
  playerLevel: 10,
  targetLevel: 10,
  playerHealth: 1,
  sneakKill: false,
  threat: true,
};

describe('kill moves', () => {
  it('end by fKillMoveMaxDuration (10 s); a hit in one does fCombatKillMoveDamageMult (10)×', () => {
    expect(COMBAT_DEFAULTS.killMoveMaxDuration).toBe(ENGINE.fKillMoveMaxDuration);
    expect(COMBAT_DEFAULTS.killMoveDamageMult).toBe(ENGINE.fCombatKillMoveDamageMult);
  });

  it('the ranged kill camera always from the long distance, else by the distance', () => {
    expect(rangedKillCameraChance({ ...shot, distance: 2000 }, vats)).toBe(100);
    expect(rangedKillCameraChance(shot, vats)).toBe(25);
  });

  it.todo('the kill move’s chance: fKillCamBaseOdds 0.1 + the level bias  [settings]');
  it.todo('the paired idle chosen by the weapon, the races and the conditions (IDLE)  [original]');
  it.todo('NPCs’ kill moves on the last enemy  [UESP Kill moves]');
  it.todo('the magic kill cam (rules read: docs/gameplay.md)  [original]');
  it.todo('the kill camera’s radial blur between shots  [original]');
});
