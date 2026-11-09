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
// counts as one, so its attack goes on as ever (its melee node's own choice); a paired idle its
// target takes is one, and the pair begins. A wolf and a bandit in the Bannered Mare, its
// patrons gone.

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

    /** Kills every actor but the player still alive (the cases before leave theirs fighting). */
    const clear = async (): Promise<void> => {
      for (const actor of sim.actors()) {
        const reference = actor.reference;
        if (reference === PLAYER_REF || (await sim.runtime.actors.isDead(reference))) continue;
        await sim.kill(reference);
      }
    };

    // The positive path: a bandit (a one-handed weapon, stamina to spare) on a wolf its next
    // strike would kill. The idle tree's KillMoveFrontSideRoot (ShouldAttackKill, facing each
    // other) and KillMoveWolfRoot give pa_KillMove1HMWolfA or B; the wolf's graph takes its side,
    // and the pair begins (#pair: the bandit leads, the wolf supports, both in the kill move,
    // the bandit the wolf's killer). The wolf is put at 1 health only just before the bandit is
    // asked (no step between), so that no plain strike of the bandit's own AI kills it first.
    it('a bandit with stamina kill-moves a wolf about to die: a paired idle its target takes', async () => {
      await clear();
      const combat = sim.world.stage.combat;
      const actors = sim.runtime.actors;
      const bandit = await sim.place(
        await sim.formId('NPC_', 'EncBandit01Melee1HTankNordM'),
        PLAYER_REF,
      );
      const wolf = await sim.place(await sim.formId('NPC_', 'EncWolf'), PLAYER_REF);
      // Foolhardy (Confidence 4): the wolf does not flee as its health runs low.
      actors.setBase(wolf, ActorValue.confidence, 4);
      await sim.step(0.2);
      // Each keeps the other as its target (the Fixed selector), not the player.
      combat.startCombat(bandit, wolf, { fixed: true });
      combat.startCombat(wolf, bandit, { fixed: true });
      let began = false;
      for (let t = 0; t < 20 && !began; t += 0.1) {
        await sim.step(0.1);
        if (await actors.isDead(wolf)) break;
        const health = await actors.value(wolf, ActorValue.health);
        if (health.current > 1) await actors.damage(wolf, ActorValue.health, health.current - 1);
        began = await combat.killMove(bandit);
        if (!began) actors.restore(wolf, ActorValue.health, 1000);
      }
      expect(began).toBe(true);
      expect(combat.combatState(bandit)?.current?.event.toLowerCase()).toMatch(/^pa_killmove/);
      expect(combat.qaFighter(bandit)?.paired).toBe('lead');
      expect(combat.qaFighter(wolf)?.paired).toBe('support');
      expect(combat.state(bandit)?.killMove).toBe(true);
      expect(combat.state(wolf)?.killMove).toBe(true);
      expect(combat.killerOf(wolf)).toBe(bandit);
    }, 600_000);

    // The melee attack node's attack reaches the host's attack with its options (its power
    // attack's cool-down, its hand): the shell then picks among the actor's attack data
    // (#meleeAttack: chooseAttackData, attackReaches) instead of the action's idle. Before, the
    // host dropped them, and every NPC's and creature's melee attack went by the idle tree. A
    // bandit (DefaultMale's sets) and a wolf (WolfProject's: attackStart_Attack1, _Attack2, its
    // power lunges) on the player, whose health is kept up.
    it('the melee node’s attacks come with its options and begin, an NPC’s and a creature’s', async () => {
      await clear();
      const combat = sim.world.stage.combat;
      const actors = sim.runtime.actors;
      const bandit = await sim.place(
        await sim.formId('NPC_', 'EncBandit01Melee1HTankNordM'),
        PLAYER_REF,
      );
      const wolf = await sim.place(await sim.formId('NPC_', 'EncWolf'), PLAYER_REF);
      await sim.step(0.2);
      const asked = new Map<number, { melee: boolean; began: boolean }[]>();
      const attack = combat.attack.bind(combat);
      combat.attack = async (reference, action, melee) => {
        const began = await attack(reference, action, melee);
        const calls = asked.get(reference) ?? [];
        calls.push({ melee: melee !== undefined, began });
        asked.set(reference, calls);
        return began;
      };
      const optioned = (reference: number): boolean =>
        asked.get(reference)?.some((call) => call.melee && call.began) === true;
      try {
        combat.startCombat(bandit, PLAYER_REF);
        combat.startCombat(wolf, PLAYER_REF);
        for (let t = 0; t < 20 && !(optioned(bandit) && optioned(wolf)); t += 0.1) {
          await sim.step(0.1);
          actors.restore(PLAYER_REF, ActorValue.health, 1000);
        }
      } finally {
        combat.attack = attack;
      }
      expect(optioned(bandit)).toBe(true);
      expect(optioned(wolf)).toBe(true);
    }, 600_000);
  },
);
