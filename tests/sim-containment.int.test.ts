// Integration test: MG05 "Containment" on the headless simulation, played through as the player
// plays it, segment by segment (each one loads the save the one before it left). Skipped without
// game data.

import { describe, expect, it } from 'vitest';
import {
  alias,
  approachAndTalk,
  converse,
  fendOff,
  keepUp,
  objective,
  travelTo,
  walkFighting,
} from './helpers/quest-play.ts';
import { hasGamedata, loadSim, openSim } from './helpers/sim.ts';

const MG05 = 0x1f255;
const MG07 = 0x1f257;
/** MG05's aliases: Mirabelle, Faralda, Tolfdir and the creatures loosed on Winterhold. */
const MIRABELLE = 1;
const FARALDA = 2;
const TOLFDIR = 22;
const CREATURES = [6, 7, 8, 31, 32, 33, 34, 35, 36, 37];
/** Where Faralda stood at the bridge's foot (MG01NiryaWaitMarker): the way over. */
const BRIDGE_FOOT = 0x379ef;
/** MG05PlayerStartMarker, in the Hall of the Elements. */
const PLAYER_START = 0x27e4c;
/** MG05CreaturesKilled. */
const CREATURES_KILLED = 0x799bc;

/** The game with Winterhold to protect (MG05 30). */
let toWinterhold: Uint8Array | undefined;
/** The game with Winterhold safe (MG05 50). */
let townSafe: Uint8Array | undefined;

describe.skipIf(!hasGamedata())('MG05 Containment', () => {
  // MG05's own start: Ancano's work on the Eye has killed the Arch-Mage (its stage 0, as MG06's
  // end sets it) and sends the player to find him (20). Tolfdir, thrown down by the blast, comes
  // to the player: "It's Ancano. He's done something with the Eye!" — and Mirabelle sends them to
  // Winterhold, overrun by what the Eye let loose (30).
  it('has Tolfdir tell of the Arch-Mage and send the player to Winterhold (MG05 30)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      void sim.runtime.quests.setStage(MG05, 0);
      expect(await sim.until(() => sim.stageDone(MG05, 20), 120)).toBe(true);
      await sim.step(1);
      // Where the blast in the Hall of the Elements leaves the player (MG05PlayerStartMarker: MG06's
      // stage 99 moves them there as Ancano's work on the Eye goes wrong).
      const start = await sim.runtime.placement(PLAYER_START);
      expect(start?.cell).toBeDefined();
      if (!start?.cell) return;
      await sim.openInterior(start.cell, { position: start.position, heading: start.rotation[2] });
      await sim.step(2);
      const tolfdir = alias(sim, MG05, TOLFDIR);
      expect(await travelTo(sim, tolfdir, 600)).toBe(true);
      const answers = [/It's Ancano/, /Arch-Mage Aren is dead/, /What happened/];
      const chosen = await keepUp(sim, tolfdir, answers, () => sim.stageDone(MG05, 30), 120);
      if (!sim.stageDone(MG05, 30)) {
        await approachAndTalk(sim, tolfdir);
        chosen.push(...(await converse(sim, answers)));
      }
      expect(chosen).toContain("It's Ancano. He's done something with the Eye!");
      expect(await sim.until(() => sim.stageDone(MG05, 30), 30)).toBe(true);
      expect(objective(sim, MG05, 30).displayed).toBe(true);
      toWinterhold = await sim.save('MG05 30');
    } finally {
      await sim.close();
    }
  }, 1_200_000);

  // Over the bridge (Faralda and Arniel hold its gate) into Winterhold, and after each creature
  // the Eye loosed there till all have fallen (40, 50).
  it('has the player clear Winterhold of the creatures (MG05 50)', async () => {
    if (!toWinterhold) return;
    const sim = await loadSim(toWinterhold);
    try {
      const faralda = alias(sim, MG05, FARALDA);
      await travelTo(sim, faralda, 600);
      await sim.listen(faralda, 10);
      await converse(sim, [/Something went wrong/, /There's no time/]);
      for (const creature of CREATURES) {
        const reference = alias(sim, MG05, creature);
        if (reference === 0 || (await sim.runtime.actors.isDead(reference))) continue;
        await travelTo(sim, reference, 300, 400);
        for (let round = 0; round < 20 && !(await sim.runtime.actors.isDead(reference)); round++) {
          await sim.step(1);
          await fendOff(sim);
        }
      }
      expect(await sim.until(() => sim.stageDone(MG05, 50), 30)).toBe(true);
      // Every creature fell, counted as the objective counts them (MG05CreatureScript).
      expect(sim.runtime.state.globals.get(CREATURES_KILLED)).toBe(CREATURES.length);
      townSafe = await sim.save('MG05 50');
    } finally {
      await sim.close();
    }
  }, 1_800_000);

  // Back to Mirabelle: "Winterhold is safe for now." (200: MG07 begins).
  it('has Mirabelle send the player after the Staff (MG05 200)', async () => {
    if (!townSafe) return;
    const sim = await loadSim(townSafe);
    try {
      const mirabelle = alias(sim, MG05, MIRABELLE);
      // Back over the bridge into the Hall of the Elements, where she holds Ancano's barrier.
      const foot = await sim.position(BRIDGE_FOOT);
      expect(foot && (await walkFighting(sim, foot, 300, 200))).toBe(true);
      const there = await travelTo(sim, mirabelle, 600);
      expect(there).toBe(true);
      expect(await approachAndTalk(sim, mirabelle)).toContain('Winterhold is safe for now.');
      await converse(sim, [
        /Winterhold is safe/,
        /Why me/,
        /What are you talking about/,
        /What coincidence/,
        /really think the Staff will help/,
        /off to Labyrinthian/,
      ]);
      expect(await sim.until(() => sim.stageDone(MG05, 200), 30)).toBe(true);
      await sim.step(1);
      expect(sim.isRunning(MG07)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 1_200_000);
});
