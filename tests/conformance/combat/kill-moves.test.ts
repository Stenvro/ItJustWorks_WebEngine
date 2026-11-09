// Conformance: kill moves and the kill camera (engine map: Combat > Kill moves).
//
// Sources: the engine's defaults (fKillMoveMaxDuration 10 s, fCombatKillMoveDamageMult 10,
// fKillCamBaseOdds 0.1, fKillCamLevelBias 0.01, …LevelMaxBias 0.1, …LevelFactor 0.5); the
// ranged kill camera's odds, observed in the original ([VATS] fVATSRanged*: docs/gameplay.md).

import { describe, expect, it } from 'vitest';
import { killMoveFirst } from '../../../src/ai/combat-tactics.ts';
import { COMBAT_DEFAULTS } from '../../../src/gameplay/combat/combat-settings.ts';
import {
  rangedKillCameraChance,
  spellPredictedKill,
} from '../../../src/gameplay/combat/ranged-kill-camera.ts';
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
  // An NPC's kill move comes by its Special Attack under ActionRightPowerAttack, by the idle
  // tree's conditions (real-fight.test.ts, melee-choice.test.ts). The rule above those conditions
  // is inferred (combat-tactics.ts killMoveFirst): it goes for one first when its strike would
  // kill the last target its group fights.
  it('NPCs’ kill moves on the last enemy: a killing strike on its group’s last target goes for one  [UESP Kill moves] (inferred)', () => {
    expect(killMoveFirst({ kills: true, groupTargets: 1 })).toBe(true);
    // Others still fighting its side: its attack data, as ever.
    expect(killMoveFirst({ kills: true, groupTargets: 2 })).toBe(false);
    // A strike that would not kill: no kill move.
    expect(killMoveFirst({ kills: false, groupTargets: 1 })).toBe(false);
  });
  it('the magic kill cam: a cast predicted to kill, on the ranged one’s odds  [original]', () => {
    expect(spellPredictedKill(49, 50)).toBe(false);
    expect(spellPredictedKill(50, 50)).toBe(true);
    expect(spellPredictedKill(0, 0)).toBe(false);
    expect(rangedKillCameraChance({ ...shot, distance: 2000 }, vats)).toBe(100);
  });
});
