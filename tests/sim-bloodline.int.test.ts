// Integration test: DLC1VQ02 "Bloodline" on the headless simulation, played through as the player
// plays it, segment by segment (each one loads the save the one before it left). Skipped without
// game data.

import { describe, expect, it } from 'vitest';
import { alias, VQ02, walkToFighting } from './helpers/sim-dawnguard.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

/** DLC1VQ02's Serana and Harkon aliases. */
const SERANA = 1;
const HARKON = 4;
/** DLC1VQCastleGuard (the gate's guard) and DLC1HunterBaseIntro "A New Order". */
const CASTLE_GUARD = 0x201a415;
const HUNTER_INTRO = 0x2004e24;
/** The crypt's way out (DLC1VQ02's DungeonExit alias: a marker by the door) and the door. */
const DUNGEON_EXIT = 0x2002997;
const EXIT_DOOR = 0x2002f73;
/** The map marker at Icewater Jetty, the rowboat to the castle (the Boat alias), the castle's door. */
const JETTY_MARKER = 0x16290;
const BOAT = 0x20028b6;
const CASTLE_DOOR = 0x2002888;
/** The castle's great hall (DLC1VampireCastleGuildhall) and Icewater's shore (Tamriel). */
const GUILDHALL = 0x2000803;
const TAMRIEL = 0x3c;
/** Where a player who refused Harkon wakes (DLC1VQ02PlayerWakeupMarkerReject). */
const WAKE_REJECTED = 0x20175cd;

/** The game with Serana out of the crypt (5, 6). */
let outOfCrypt: Uint8Array | undefined;
/** The game in the castle's hall with Serana, Harkon waiting (9). */
let beforeHarkon: Uint8Array | undefined;

/**
 * The player walks towards a reference, a few steps at a time, until someone speaks to them (a
 * force greet on the way); the topics then, or undefined.
 */
async function walkUntilSpoken(
  sim: Sim,
  target: number,
  speaker: number,
  friends: readonly number[],
  seconds: number,
): Promise<string[] | undefined> {
  const until = sim.time + seconds;
  while (sim.time < until) {
    await walkToFighting(sim, target, 2, 200, friends);
    const topics = await sim.listen(speaker, 0.5);
    if (topics !== undefined) return topics;
  }
  return undefined;
}

/** Harkon's questions answered, to his offer ("And if I refuse your gift?"; 15). */
async function hearHarkon(sim: Sim): Promise<boolean> {
  const harkon = alias(sim, VQ02, HARKON);
  let topics: string[] | undefined;
  // He takes his seat as the feast's scene leaves him (the player goes up to him there).
  for (let tries = 0; tries < 6 && !topics?.some((topic) => topic.startsWith("I'm ")); tries++) {
    const at = await sim.position(harkon);
    if (at) await sim.walkPath(at, 20, 150);
    topics = await sim.talk(harkon, 10);
    if (!topics) await sim.step(5);
    else if (!topics.some((topic) => topic.startsWith("I'm "))) sim.goodbye();
  }
  if (!topics?.some((topic) => topic.startsWith("I'm "))) return false;
  await sim.choose(/^I'm /);
  await sim.choose(/You're vampires/);
  topics = await sim.choose(/reward for finding your daughter/);
  if (!topics.includes('And if I refuse your gift?')) return false;
  await sim.choose(/And if I refuse your gift/);
  sim.goodbye();
  return sim.until(() => sim.stageDone(VQ02, 15), 20);
}

/** Harkon asks again (the conversation he starts: his offer's choice); the topics. */
async function harkonAsks(sim: Sim): Promise<string[] | undefined> {
  const harkon = alias(sim, VQ02, HARKON);
  for (let tries = 0; tries < 6; tries++) {
    const topics = await sim.listen(harkon, 10);
    if (topics?.some((topic) => topic.includes('your gift'))) return topics;
    // He first asks his questions again ("I'm ..."): answered as before.
    if (topics?.some((topic) => topic.startsWith("I'm "))) {
      await sim.choose(/^I'm /);
      await sim.choose(/You're vampires/);
      await sim.choose(/reward for finding your daughter/);
      await sim.choose(/And if I refuse your gift/);
      sim.goodbye();
    }
  }
  return undefined;
}

describe.skipIf(!hasGamedata())('DLC1VQ02 Bloodline', () => {
  // DLC1VQ02's own start for a game that skips ahead: its stage 0 puts the player and Serana by
  // her coffin (Awakening's end, played in sim-awakening) and sets 5: Serana follows the player
  // out of the crypt, past the gargoyles (6), to its way out.
  it('has Serana follow the player out of Dimhollow Crypt (5, 6)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      void sim.runtime.quests.setStage(VQ02, 0);
      expect(await sim.until(() => sim.stageDone(VQ02, 5), 30)).toBe(true);
      await sim.openAtPlayer();
      await sim.step(3);
      const serana = alias(sim, VQ02, SERANA);
      expect(sim.package(serana)?.procedure).toBe('Follow');
      expect(await walkToFighting(sim, DUNGEON_EXIT, 300, 250, [serana])).toBe(true);
      expect(sim.stageDone(VQ02, 6)).toBe(true);
      expect(sim.activate(EXIT_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(3);
      expect((await sim.runtime.placement(PLAYER_REF))?.world).toBe(TAMRIEL);
      expect(await sim.distance(serana, PLAYER_REF)).toBeLessThan(500);
      outOfCrypt = await sim.save('Bloodline out');
    } finally {
      await sim.close();
    }
  }, 900_000);

  // To Icewater Jetty (the way there is not under test), Serana along; the rowboat over to the
  // castle's island. On the way up she stops the player ("Hey, so... before we go in there...":
  // her ForceGreet, whose info asks that it runs); what she says opens the gate (the castle
  // guard's 20), and in through the castle's door: Harkon greets his daughter (8, 9).
  // Found 2026-11-18: the conversation's first line was picked when the test heard it, by then
  // her ForceGreet had ended, and her generic follower topics came instead of hers; the line is
  // picked as the menu opens now, as the dialogue menu picks it. And her followers' package was
  // not running yet right after the load: the player waits a moment before fast travelling.
  it('has Serana take the player to Castle Volkihar and Harkon (8, 9)', async () => {
    if (!outOfCrypt) return;
    const sim = await loadSim(outOfCrypt);
    try {
      const serana = alias(sim, VQ02, SERANA);
      await sim.step(3);
      await sim.fastTravel(JETTY_MARKER);
      await sim.step(3);
      expect(await sim.distance(serana, PLAYER_REF)).toBeLessThan(500);
      expect(await walkToFighting(sim, BOAT, 300, 200, [serana])).toBe(true);
      expect(sim.activate(BOAT)).toBe(true);
      await sim.world.settle();
      await sim.step(3);
      expect(await sim.distance(serana, PLAYER_REF)).toBeLessThan(500);
      const topics = await walkUntilSpoken(sim, CASTLE_DOOR, serana, [serana], 80);
      expect(topics).toEqual(['What is it?', 'Are you all right?', 'What is it now?']);
      expect(await sim.choose(/What is it\?/)).toEqual([]);
      sim.goodbye();
      await sim.step(3);
      expect(sim.stage(CASTLE_GUARD)).toBe(20);
      expect(await walkToFighting(sim, CASTLE_DOOR, 120, 200, [serana])).toBe(true);
      expect(sim.activate(CASTLE_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(3);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(GUILDHALL);
      const harkon = alias(sim, VQ02, HARKON);
      for (let tries = 0; tries < 30 && !sim.stageDone(VQ02, 8); tries++) {
        await walkToFighting(sim, harkon, 4, 400, [serana]);
      }
      expect(sim.stageDone(VQ02, 8)).toBe(true);
      // The feast's scene plays out (Harkon and Serana), then he waits for the player (9).
      expect(await sim.until(() => sim.stageDone(VQ02, 9), 240)).toBe(true);
      expect(sim.runtime.state.quest(VQ02).objectives.get(20)?.displayed).toBe(true);
      beforeHarkon = await sim.save('Bloodline Harkon');
    } finally {
      await sim.close();
    }
  }, 900_000);

  // Harkon thanks the player and makes his offer (15); refused (20, 30), he sends them away:
  // they wake on the shore (DLC1VQ02PlayerWakeupMarkerReject), Bloodline done (200) and A New
  // Order begun (its 20: back to Isran).
  it('has Harkon banish a player who refuses his gift (30, 200)', async () => {
    if (!beforeHarkon) return;
    const sim = await loadSim(beforeHarkon);
    try {
      await sim.step(2);
      expect(await hearHarkon(sim)).toBe(true);
      const topics = await harkonAsks(sim);
      expect(topics).toContain("I don't want to become a vampire. I refuse your gift.");
      expect(await sim.choose(/I refuse your gift\.$/)).toEqual([]);
      sim.goodbye();
      expect(sim.stageDone(VQ02, 20)).toBe(true);
      expect(await sim.until(() => sim.stageDone(VQ02, 200), 120)).toBe(true);
      expect(sim.stageDone(VQ02, 30)).toBe(true);
      expect(sim.stageDone(HUNTER_INTRO, 20)).toBe(true);
      let away = await sim.distance(PLAYER_REF, WAKE_REJECTED);
      for (let i = 0; i < 20 && (away ?? Infinity) >= 300; i++) {
        await sim.step(1);
        away = await sim.distance(PLAYER_REF, WAKE_REJECTED);
      }
      expect(away).toBeLessThan(300);
    } finally {
      await sim.close();
    }
  }, 900_000);
});
