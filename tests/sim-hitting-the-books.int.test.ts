// Integration test: MG03 "Hitting the Books" on the headless simulation, played through as the
// player plays it, segment by segment (each one loads the save the one before it left). Skipped
// without game data.

import { describe, expect, it } from 'vitest';
import {
  alias,
  approachAndTalk,
  converse,
  fendOff,
  goThrough,
  objective,
  walkFighting,
} from './helpers/quest-play.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF } from './helpers/sim.ts';

const MG02 = 0x1f252;
const MG03 = 0x1f253;
const MG04 = 0x1f254;
/** MG03's aliases: Urag, the three books, the Caller. */
const URAG = 1;
const BOOKS = [4, 14, 15];
const CALLER = 6;
/** WinterholdMapMarker, FellglowKeepMapMarker; the courtyard's door to the Hall of the Elements,
 * the Arcanaeum's. */
const WINTERHOLD_MARKER = 0x177ef;
const FELLGLOW_MARKER = 0x16244;
const HALL_OF_THE_ELEMENTS_DOOR = 0x177f9;
const ARCANAEUM_DOOR = 0x175dd;
/** Where Faralda stood at the bridge's foot (MG01NiryaWaitMarker): the way over. */
const BRIDGE_FOOT = 0x379ef;
/** Fellglow's way up: the dungeon's hole from Tamriel (dunFellglow_DungeonEnt), the doors from
 * FellglowKeep01 to 02 (two ways) and from 02 to 03, and FellglowKeep03. */
const FELLGLOW_HOLE = 0x71aa3;
const KEEP01_TO_02 = [0x739b4, 0x7352f];
const KEEP02_TO_03 = 0x73b87;
const FELLGLOW_KEEP_03 = 0xc9dab;

/** The game with Urag's errand (MG03 30). */
let sentToFellglow: Uint8Array | undefined;
/** The game with the three books found (MG03 60). */
let booksFound: Uint8Array | undefined;

describe.skipIf(!hasGamedata())('MG03 Hitting the Books', () => {
  // MG03's own start for a game that skips ahead: its stage 0 plays MG01 and MG02 to 200 (played
  // in sim-first-lessons and sim-under-saarthal) and sends the player to Urag (20). Over the
  // bridge and up to the Arcanaeum: "I need to learn about something we found in Saarthal", "You
  // don't have anything that can help?" — Orthorn took the books to Fellglow Keep (30).
  it('has Urag send the player to Fellglow Keep (MG03 30)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      void sim.runtime.quests.setStage(MG03, 0);
      expect(await sim.until(() => sim.stageDone(MG03, 20), 120)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(MG02, 200)).toBe(true);
      expect(objective(sim, MG03, 20).displayed).toBe(true);
      await sim.fastTravel(WINTERHOLD_MARKER);
      await sim.step(2);
      const foot = await sim.position(BRIDGE_FOOT);
      expect(foot && (await sim.walkPath(foot, 120, 200))).toBe(true);
      expect(await goThrough(sim, HALL_OF_THE_ELEMENTS_DOOR, 200)).toBe(true);
      expect(await goThrough(sim, ARCANAEUM_DOOR, 120)).toBe(true);
      const urag = alias(sim, MG03, URAG);
      const topics = await approachAndTalk(sim, urag);
      expect(topics).toContain('I need to learn about something we found in Saarthal.');
      await sim.choose(/something we found in Saarthal/);
      await sim.choose(/anything that can help/);
      sim.goodbye();
      expect(await sim.until(() => sim.stageDone(MG03, 30), 10)).toBe(true);
      expect(sim.runtime.mapMarkerVisible(FELLGLOW_MARKER)).toBe(true);
      sentToFellglow = await sim.save('MG03 30');
    } finally {
      await sim.close();
    }
  }, 1_200_000);

  // To Fellglow Keep, in by the dungeon's hole, up through the keep (its cells' doors) to the
  // ritual room, where the Caller waits with the books. Her greeting, "Who are you?", "I'm here
  // for the books from the College.", "May I please have the books?": she will not part with
  // them; the books taken from her table set her on the player (MG03BookScript), and she falls.
  // The three books found (60).
  it('has the player take the books from the Caller in Fellglow Keep (MG03 60)', async () => {
    if (!sentToFellglow) return;
    const sim = await loadSim(sentToFellglow);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      await sim.fastTravel(FELLGLOW_MARKER);
      await sim.step(2);
      for (const doors of [[FELLGLOW_HOLE], KEEP01_TO_02, [KEEP02_TO_03]]) {
        let door: number | undefined;
        for (const candidate of doors) {
          const at = await sim.position(candidate);
          const there = at && (await walkFighting(sim, at, 300, 150));
          if (there) {
            door = candidate;
            break;
          }
        }
        expect(door).toBeDefined();
        if (door === undefined) return;
        expect(sim.activate(door)).toBe(true);
        await sim.world.settle();
        await sim.step(1);
      }
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(FELLGLOW_KEEP_03);
      const caller = alias(sim, MG03, CALLER);
      const callerAt = await sim.position(caller);
      expect(callerAt && (await walkFighting(sim, callerAt, 120, 400))).toBe(true);
      let topics = await sim.listen(caller, 30);
      topics ??= await approachAndTalk(sim, caller);
      expect(topics).toContain('Who are you?');
      const asked = await converse(sim, [
        /Who are you/,
        /here for the books/,
        /please have the books/,
      ]);
      expect(asked).toEqual([
        'Who are you?',
        "I'm here for the books from the College.",
        'May I please have the books?',
      ]);
      for (const book of BOOKS) {
        const reference = alias(sim, MG03, book);
        const at = await sim.position(reference);
        expect(at && (await walkFighting(sim, at, 120, 100))).toBe(true);
        expect(await sim.takeBook(reference)).toBe(true);
        await sim.step(1);
        await fendOff(sim);
      }
      expect(await sim.until(() => sim.stageDone(MG03, 60), 10)).toBe(true);
      // Her books gone, she fought for them, and fell.
      expect(sim.deaths().some((death) => death.actor === caller)).toBe(true);
      expect(objective(sim, MG03, 60).displayed).toBe(true);
      booksFound = await sim.save('MG03 60');
    } finally {
      await sim.close();
    }
  }, 1_200_000);

  // Back to the College with the books: "Here are the books that went missing." (200: the
  // books traded for Urag's rewards, MG04 begins).
  it('has Urag take the books back (MG03 200)', async () => {
    if (!booksFound) return;
    const sim = await loadSim(booksFound);
    try {
      await sim.fastTravel(WINTERHOLD_MARKER);
      await sim.step(2);
      const foot = await sim.position(BRIDGE_FOOT);
      expect(foot && (await sim.walkPath(foot, 120, 200))).toBe(true);
      expect(await goThrough(sim, HALL_OF_THE_ELEMENTS_DOOR, 200)).toBe(true);
      expect(await goThrough(sim, ARCANAEUM_DOOR, 120)).toBe(true);
      const urag = alias(sim, MG03, URAG);
      expect(await approachAndTalk(sim, urag)).toContain('Here are the books that went missing.');
      await sim.choose(/books that went missing/);
      sim.goodbye();
      expect(await sim.until(() => sim.stageDone(MG03, 200), 10)).toBe(true);
      await sim.step(1);
      expect(sim.isRunning(MG03)).toBe(false);
      expect(sim.isRunning(MG04)).toBe(true);
      for (const book of BOOKS) {
        expect(await sim.runtime.itemCount(PLAYER_REF, alias(sim, MG03, book))).toBe(0);
      }
    } finally {
      await sim.close();
    }
  }, 1_200_000);
});
