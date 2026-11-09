// Conformance: kill moves and the kill camera (engine map: Combat > Kill moves).
//
// Sources: the engine's defaults (fKillMoveMaxDuration 10 s, fCombatKillMoveDamageMult 10,
// fKillCamBaseOdds 0.1, fKillCamLevelBias 0.01, …LevelMaxBias 0.1, …LevelFactor 0.5); the
// ranged kill camera's odds, observed in the original ([VATS] fVATSRanged*: docs/gameplay.md).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { killMoveFirst } from '../../../src/ai/combat-tactics.ts';
import { COMBAT_DEFAULTS } from '../../../src/gameplay/combat/combat-settings.ts';
import {
  rangedKillCameraChance,
  spellPredictedKill,
} from '../../../src/gameplay/combat/ranged-kill-camera.ts';
import { ActorValue } from '../../../src/world/actor-values.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';
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

// An NPC's kill move is a paired idle only (actor-combat.ts killMove): its Special Attack's action
// gives a creature its power attack and a fighter without stamina its plain attack, and neither
// counts as one, so its attack goes on as ever (its melee node's own choice). A wolf and a
// bandit in the Bannered Mare, its patrons gone.

const BANNERED_MARE = 0x1605e;

describe.skipIf(!hasGamedata())(
  'an NPC’s kill move is a paired idle only (headless simulation)',
  () => {
    let sim: Sim;

    beforeAll(async () => {
      sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
      await sim.step(1);
      for (const actor of sim.actors()) {
        if (actor.reference !== PLAYER_REF) await sim.kill(actor.reference);
      }
    }, 600_000);
    afterAll(async () => {
      await sim.close();
    });

    /** Steps until the actor could attack: its kill move asked, then the action's own attack. */
    const askBoth = async (
      actor: number,
      before?: () => Promise<void>,
    ): Promise<{ killMove: boolean; attack: boolean }> => {
      const combat = sim.world.stage.combat;
      combat.startCombat(actor, PLAYER_REF);
      for (let t = 0; t < 10; t += 0.1) {
        await sim.step(0.1);
        await before?.();
        const killMove = await combat.killMove(actor);
        // Asked at once after, in the same frame: the action's own attack.
        const attack = await combat.attack(actor, 'ActionRightPowerAttack');
        if (attack || killMove) return { killMove, attack };
      }
      return { killMove: false, attack: false };
    };

    it('a wolf’s power attack is no kill move', async () => {
      const wolf = await sim.place(await sim.formId('NPC_', 'EncWolf'), PLAYER_REF);
      const asked = await askBoth(wolf);
      expect(asked.attack).toBe(true);
      expect(asked.killMove).toBe(false);
      await sim.kill(wolf);
    }, 600_000);

    it('a bandit without stamina makes no kill move of its plain attack', async () => {
      const bandit = await sim.place(
        await sim.formId('NPC_', 'EncBandit01Melee1HTankNordM'),
        PLAYER_REF,
      );
      const asked = await askBoth(bandit, async () => {
        const stamina = await sim.runtime.actors.value(bandit, ActorValue.stamina);
        if (stamina.current > 0) {
          await sim.runtime.actors.damage(bandit, ActorValue.stamina, stamina.current);
        }
      });
      expect(asked.attack).toBe(true);
      expect(asked.killMove).toBe(false);
    }, 600_000);
  },
);
