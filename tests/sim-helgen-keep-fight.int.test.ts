// Integration test: MQ101's first fight in Helgen Keep on Ralof's route, by real input. The
// player goes in with Ralof (stage 220), loots Gunjar when told to (255), puts on his gear (the
// iron war axe, the cuirass and boots), and when the two Imperials come through the gate
// (stage 270: SetEnemy on the player's faction and StartCombat on the player) fights them with
// button presses and turns only. Skipped without game data.
//
// The fight as the data sets it up (UESP "Unbound"; MQ101's stage 270 fragments): the officer
// and the soldier are level 1 (96 health) and carry MQ101ReduceAttackDamage (Mod Attack Damage
// × 0.5), the officer MQ101ReduceDamage too (Mod Incoming Damage × 0.5); the same fragment sets
// MQ101TemporaryFriendsFaction neutral to itself (SetEnemy(itself, true, true)), which leaves
// Ralof's CWSonsFactionNPC and the soldiers' CWImperialFactionNPC enemies: Ralof fights them
// beside the player: a shared faction that names a reaction to itself counts by that reaction,
// not by its membership (docs/gameplay.md "Factions and reactions"; one that names none, as the
// town and guard factions, makes its members allies). Found 2026-11-09: a faction both were in
// (TemporaryFriends) made them allies by itself, so Ralof stood by (not one blow) and the two soldiers wore the player down
// alone: by real input the player died with the officer at 21 health and the soldier untouched.

import { describe, expect, it } from 'vitest';
import { reactionOf, FightReaction } from '../src/ai/combat-reactions.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const MQ101 = 0x3372b;
/** HelgenKeep01. */
const KEEP = 0x5de24;
/** MQ101KeepIntroSceneB (Ralof's route). */
const INTRO_RALOF = 0x4e1e2;
/** MQ101's Ralof alias. */
const RALOF = 12;
/** Gunjar's body (MQ101CorpseSons01), lying in the keep. */
const GUNJAR = 0xb1694;
/** MQ101's BarracksRoomSoldier01 (the officer) and BarracksRoomSoldier02. */
const BARRACKS_OFFICER = 173;
const BARRACKS_SOLDIER = 174;

/** The player keeps by an actor (within the 100 units "wait for the player" phases ask). */
async function keepBy(sim: Sim, actor: number): Promise<void> {
  const near = await sim.distance(actor, PLAYER_REF);
  const at = await sim.position(actor);
  const me = await sim.position(PLAYER_REF);
  if (near !== undefined && near > 95 && at && me) {
    const k = 80 / near;
    await sim.moveTo([at[0] + (me[0] - at[0]) * k, at[1] + (me[1] - at[1]) * k, at[2] + 10]);
  }
}

describe.skipIf(!hasGamedata())('MQ101’s first fight in Helgen Keep, by real input', () => {
  it('Ralof fights the two Imperials beside the player, and they win', async () => {
    const sim = await openSim({ opening: true });
    try {
      await sim.step(1);
      for (const playing of sim.runtime.scenes.snapshot()) sim.runtime.scenes.stop(playing.scene);
      // As MQ101SetStage220 does when the player walks in with Ralof.
      void sim.runtime.quests.setStage(MQ101, 220);
      await sim.step(0.5);
      await sim.openInterior(KEEP);
      for (const playing of sim.runtime.scenes.snapshot()) {
        if (playing.scene !== INTRO_RALOF) sim.runtime.scenes.stop(playing.scene);
      }
      const quest = sim.runtime.state.quest(MQ101);
      const ralof = quest.aliases.get(RALOF) ?? 0;
      let looted = false;
      for (let second = 0; second < 150 && !sim.stageDone(MQ101, 270); second++) {
        await sim.step(1);
        await keepBy(sim, ralof);
        if (!looted && sim.stageDone(MQ101, 255)) {
          const [x, y, z] = sim.actor(GUNJAR)?.position ?? [0, 0, 0];
          await sim.moveTo([x + 80, y, z + 10]);
          await sim.step(0.5);
          looted = sim.activate(GUNJAR);
          // Gunjar's gear, taken and put on (as the "Find some equipment" objective has it).
          for (const [item, count] of await sim.runtime.inventory(GUNJAR)) {
            await sim.take(GUNJAR, item, count);
            const type = (await sim.runtime.forms.db.get(item))?.type;
            if (type === 'WEAP' || type === 'ARMO') await sim.equip(item);
          }
        }
      }
      expect(looted).toBe(true);
      expect(sim.stageDone(MQ101, 270)).toBe(true);
      const officer = quest.aliases.get(BARRACKS_OFFICER) ?? 0;
      const soldier = quest.aliases.get(BARRACKS_SOLDIER) ?? 0;
      // From stage 270 on Ralof and the Imperials are enemies (their CW factions), no longer
      // friends by the faction they share.
      expect(await reactionOf(sim.runtime, ralof, officer)).toBe(FightReaction.enemy);
      expect(await reactionOf(sim.runtime, soldier, ralof)).toBe(FightReaction.enemy);

      const dead = (who: number): Promise<boolean> => sim.runtime.actors.isDead(who);
      // The player cannot die here (immortal mode): whether a level 1 player outlasts the fight
      // turns on where three melee fighters happen to stand (Ralof's swings that miss the officer
      // can fall on the player beside him), not on what this case is about.
      sim.runtime.debug.immortal = true;
      // The player takes on the soldier while Ralof goes for the officer (his scene's package
      // sends him to the officer), then whichever is left, until both are down.
      for (let round = 0; round < 120; round++) {
        if ((await dead(officer)) && (await dead(soldier))) break;
        await sim.swingAt((await dead(soldier)) ? officer : soldier, 110);
      }
      const hits = sim.events('hit');
      const on = (who: number, targets: readonly number[]): number =>
        hits.filter((hit) => hit.aggressor === who && targets.includes(hit.target)).length;
      // Ralof fights them (before: not one blow, he stood by as their ally).
      expect(on(ralof, [officer, soldier])).toBeGreaterThan(0);
      // Each soldier fights its own enemies: its blows at the one it aims at land on it, not on
      // its fellow at its side (before: the officer's blows at the player fell on the soldier).
      expect(on(officer, [PLAYER_REF, ralof])).toBeGreaterThan(on(officer, [soldier]));
      // An NPC swings when its attack will reach its target at the hit frame (the melee attack
      // node's attackReaches): the combat AI's own attack choice reaches the actor's graph. Found
      // 2026-11-09: the stage's bridge to the AI dropped the choice, every NPC swing went to its
      // graph unchecked, from up to 450 units, and its blow fell on whoever stood in its cone:
      // 6 of the Imperials' 20 blows on each other, 14 of Ralof's 26 on the player.
      expect(on(officer, [soldier]) + on(soldier, [officer])).toBe(0);
      expect(on(ralof, [officer, soldier])).toBeGreaterThan(on(ralof, [PLAYER_REF]));
      expect(await dead(officer)).toBe(true);
      expect(await dead(soldier)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 900_000);
});
