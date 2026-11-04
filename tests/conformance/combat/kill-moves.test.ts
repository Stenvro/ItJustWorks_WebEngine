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

  // fKillCamBaseOdds and its level bias are read in the original only by a function nothing calls
  // (docs/completeness/combat.md, round 4b): nothing to test. The paired idle's choice by weapon,
  // races and conditions: tests/killmoves.int.test.ts. The radial blur between shots:
  // kill-camera-shots.test.ts and src/gameplay/combat/kill-camera-transition.test.ts.
  it.todo(
    'NPCs’ kill moves on the last enemy: which rule starts an NPC’s was not read  [UESP Kill moves]',
  );
  it.todo(
    'the magic kill cam: needs the spells’ projectile predicted to kill (rules read: docs/gameplay.md)  [original]',
  );
});
