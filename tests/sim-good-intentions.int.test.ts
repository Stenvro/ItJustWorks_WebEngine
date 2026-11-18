// Integration test: MG04 "Good Intentions" on the headless simulation, played through as the
// player plays it, segment by segment (each one loads the save the one before it left). Skipped
// without game data.

import { describe, expect, it } from 'vitest';
import {
  alias,
  approachAndTalk,
  converse,
  follow,
  goThrough,
  keepUp,
  objective,
  walkFighting,
} from './helpers/quest-play.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF } from './helpers/sim.ts';

const MG03 = 0x1f253;
const MG04 = 0x1f254;
/** MG04's aliases: Ancano, Quaranir, the Augur, Tolfdir and the Augur's door. */
const ANCANO = 0;
const QUARANIR = 1;
const AUGUR = 4;
const TOLFDIR = 5;
const AUGUR_DOOR = 13;
const QUARANIR_TRIGGER = 16;
/** WinterholdMapMarker, the bridge's foot, the courtyard's door to the Hall of the Elements. */
const WINTERHOLD_MARKER = 0x177ef;
const BRIDGE_FOOT = 0x379ef;
const HALL_OF_THE_ELEMENTS_DOOR = 0x177f9;
/** The way from the Arch-Mage's quarters down into the Hall, the Hall's way out to the courtyard,
 * the Midden's hatch from the courtyard, the door from the Midden's first cell to its second, and
 * that second cell. */
const QUARTERS_TO_HALL = 0xcc821;
const HALL_OUT = 0x175ef;
const MIDDEN_HATCH = 0x58244;
const MIDDEN_01_TO_02 = 0xafc36;
const MIDDEN_02 = 0xae783;

/** The game after Quaranir's warning (MG04 40). */
let warned: Uint8Array | undefined;

describe.skipIf(!hasGamedata())('MG04 Good Intentions', () => {
  // MG04's own start for a game that skips ahead: its stage 0 plays MG01 to MG03 to 200 (played in
  // their sims) and sends the player to Tolfdir (10), at the Eye in the Hall of the Elements.
  // "Urag suggested I come see you." (15: his lecture on the Eye), Ancano's interruption (20:
  // "What do you want with me?", and he leads to the Arch-Mage's quarters), where time stops and
  // Quaranir of the Psijic Order speaks to the player alone (30, 40: find the Augur of Dunlain).
  it('has Ancano bring the player to Quaranir (MG04 40)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      void sim.runtime.quests.setStage(MG04, 0);
      expect(await sim.until(() => sim.stageDone(MG04, 10), 120)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(MG03, 200)).toBe(true);
      expect(objective(sim, MG04, 10).displayed).toBe(true);
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      await sim.fastTravel(WINTERHOLD_MARKER);
      await sim.step(2);
      const foot = await sim.position(BRIDGE_FOOT);
      expect(foot && (await sim.walkPath(foot, 120, 200))).toBe(true);
      expect(await goThrough(sim, HALL_OF_THE_ELEMENTS_DOOR, 200)).toBe(true);
      const tolfdir = alias(sim, MG04, TOLFDIR);
      expect(await approachAndTalk(sim, tolfdir)).toContain('Urag suggested I come see you.');
      await converse(sim, [/Urag suggested/, /Night of Tears/]);
      expect(await sim.until(() => sim.stageDone(MG04, 15), 10)).toBe(true);
      const ancano = alias(sim, MG04, ANCANO);
      const answers = [
        /What do you want with me/,
        /don't understand what's going on/,
        /What do you want me to say/,
        /What's going on\? What happened/,
        /So what exactly is the problem/,
        /I'll help, but I don't know what to do/,
        /Who is the Augur of Dunlain/,
        /Where can I find this Augur/,
      ];
      // Near Tolfdir through his lecture on the Eye (MG04ClassroomScene waits for the player within
      // 600 units), until Ancano cuts in (20); then after Ancano.
      const heard = await keepUp(sim, tolfdir, answers, () => sim.stageDone(MG04, 20), 600, 300);
      expect(heard).toContain("I don't understand what's going on.");
      await keepUp(sim, ancano, answers, () => sim.stageDone(MG04, 30), 600);
      expect(sim.stageDone(MG04, 30)).toBe(true);
      // Into the quarters, where the player's step starts the monk's scene
      // (defaultStartSceneTrigScript: MG04QuaranirSceneTrigger).
      const quaranir = alias(sim, MG04, QUARANIR);
      const sameCell = async (): Promise<boolean> =>
        (await sim.runtime.placement(PLAYER_REF))?.cell ===
        (await sim.runtime.placement(quaranir))?.cell;
      expect(await follow(sim, quaranir, sameCell, 300)).toBe(true);
      const trigger = await sim.position(alias(sim, MG04, QUARANIR_TRIGGER));
      expect(trigger && (await walkFighting(sim, trigger, 120, 60))).toBe(true);
      // His opening line said (MG04QuaranirOpeningLineScene), the player speaks with him.
      const asked = (await sim.listen(quaranir, 60)) ?? (await approachAndTalk(sim, quaranir));
      expect(asked).toContain("What's going on? What happened to everyone?");
      const monk = [
        /What's going on\? What happened/,
        /What do you want with me/,
        /What did you do/,
        /If this is dangerous/,
        /What does this have to do with me/,
        /So what exactly is the problem/,
        /What do you expect from me/,
        /I'll help, but/,
        /Who is the Augur/,
        /Where can I find this Augur/,
      ];
      const told: string[] = [];
      told.push(...(await converse(sim, monk)));
      for (let again = 0; again < 8 && !sim.stageDone(MG04, 40); again++) {
        if ((await approachAndTalk(sim, quaranir)).length === 0) await sim.step(1);
        told.push(
          ...(await converse(
            sim,
            monk.filter((each) => !told.some((t) => each.test(t))),
          )),
        );
      }
      expect(await sim.until(() => sim.stageDone(MG04, 40), 30)).toBe(true);
      warned = await sim.save('MG04 40');
    } finally {
      await sim.close();
    }
  }, 1_200_000);

  // Out to the courtyard and down the hatch into the Midden, through its first cell to its
  // second, and the Augur of Dunlain behind its door: "So you're the Augur of Dunlain?" (50:
  // report to Savos Aren).
  it('has the Augur of Dunlain speak to the player in the Midden (MG04 50)', async () => {
    if (!warned) return;
    const sim = await loadSim(warned);
    try {
      // Down from the Arch-Mage's quarters into the Hall, out to the courtyard, down the hatch.
      for (const door of [QUARTERS_TO_HALL, HALL_OUT, MIDDEN_HATCH]) {
        expect(await goThrough(sim, door, 200)).toBe(true);
      }
      const inner = await sim.position(MIDDEN_01_TO_02);
      expect(inner && (await walkFighting(sim, inner, 300, 150))).toBe(true);
      expect(sim.activate(MIDDEN_01_TO_02)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(MIDDEN_02);
      const door = alias(sim, MG04, AUGUR_DOOR);
      const doorAt = await sim.position(door);
      expect(doorAt && (await walkFighting(sim, doorAt, 300, 150))).toBe(true);
      // Its door, shut (a plain door, its lock given at 200).
      if (sim.openState(door) !== 1) sim.activate(door);
      await sim.step(2);
      const augur = alias(sim, MG04, AUGUR);
      const augurAt = await sim.position(augur);
      expect(augurAt && (await walkFighting(sim, augurAt, 120, 300))).toBe(true);
      // A talking activator: activated, it talks with the player.
      expect(await approachAndTalk(sim, augur)).toContain("So you're the Augur of Dunlain?");
      const augurTopics = [
        /So you're the Augur/,
        /I was told to find you/,
        /what is it I'm seeking/,
        /What do I need/,
        /What Thalmor/,
        /not the first to come see you/,
      ];
      const heard = await converse(sim, augurTopics);
      for (let again = 0; again < 8 && !sim.stageDone(MG04, 50); again++) {
        if ((await approachAndTalk(sim, augur)).length === 0) await sim.step(1);
        heard.push(
          ...(await converse(
            sim,
            augurTopics.filter((each) => !heard.some((t) => each.test(t))),
          )),
        );
      }
      expect(await sim.until(() => sim.stageDone(MG04, 50), 60)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 1_200_000);
  // TODO(M13): back up to the Arch-Mage ("I have important information for you.": 200, MG06
  // begins): Savos, found in the Hall of the Elements at the Eye, lists "What did the Psijic
  // want?" but not MG04Stage50SavosArenBranch's topic, though its info's conditions (MG04 at 50,
  // GetIsID Savos) hold; MG06's sim starts after it (its stage 0 sets MG04's 200).
});
