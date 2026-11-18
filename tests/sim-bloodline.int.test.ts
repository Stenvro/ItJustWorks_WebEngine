// Integration test: DLC1VQ02 "Bloodline" on the headless simulation, played through as the player
// plays it, segment by segment (each one loads the save the one before it left). Skipped without
// game data.

import { describe, expect, it } from 'vitest';
import { ObjectHandle } from '../src/scripting/values.ts';
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
/** Where a player Harkon turned wakes (DLC1VQ02PlayerWakeupMarker), by his shrine. */
const WAKE_ACCEPTED = 0x20175cc;
/** DLC1VampireTutorial "Power of the Blood" and its lesson (DLC1VampireTutorialScene1). */
const TUTORIAL = 0x201909f;
const LESSON = 0x20191e8;

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

/** The player's race now (Actor.GetRace). */
async function raceOf(sim: Sim): Promise<number | undefined> {
  const race = await sim.native(new ObjectHandle(PLAYER_REF, 'Actor'), 'Actor', 'GetRace', []);
  return race instanceof ObjectHandle ? race.formId : undefined;
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
  // picked as the menu opens now, as the dialogue menu picks it. (Right after the load her Follow
  // package has not been chosen yet: the player waits a moment before fast travelling.)
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

  // Accepted, Harkon bites the player (DLC1VampireTurnScript.HarkonBitesPlayer): they wake a
  // vampire by the shrine (40), and Power of the Blood begins (DLC1VampireTutorial 10). Leaving
  // the spot they woke in (DLC1VampireTutorialStartTrigger: 20), Harkon comes to them ("Awake at
  // last"); ready to learn (30), his scene teaches the Vampire Lord: the player transforms with
  // the power he gave them, lands when he tells them to, and listens to the end (50). His task
  // asked for (100), Bloodline ends (180, 200) on the vampires' side.
  // Found 2026-11-18: VampireChange hung in SendVampirismStateChanged, which waited for the
  // player's handlers; transformed, the player was attacked on sight by Harkon himself, his
  // scene ended in the fight, until a friend's reaction (DLC1VampireFaction to
  // DLC1PlayerVampireLordFaction) kept him from it.
  it('has Harkon turn a player who accepts his gift and teach them the Vampire Lord (40, 200)', async () => {
    if (!beforeHarkon) return;
    const sim = await loadSim(beforeHarkon);
    try {
      await sim.step(2);
      expect(await hearHarkon(sim)).toBe(true);
      const offer = await harkonAsks(sim);
      expect(offer?.some((topic) => topic.includes('accept your gift'))).toBe(true);
      expect(await sim.choose(/accept your gift/)).toEqual([]);
      sim.goodbye();
      expect(await sim.until(() => sim.stageDone(VQ02, 40), 60)).toBe(true);
      expect(sim.stageDone(VQ02, 30)).toBe(false);
      expect(await sim.until(() => sim.stage(TUTORIAL) === 10, 10)).toBe(true);
      expect(await sim.distance(PLAYER_REF, WAKE_ACCEPTED)).toBeLessThan(150);
      const vampire = await sim.formId('RACE', 'NordRaceVampire');
      expect(await raceOf(sim)).toBe(vampire);
      const power = await sim.formId('SPEL', 'DLC1VampireChange');
      expect(await sim.runtime.actors.hasSpell(PLAYER_REF, power)).toBe(true);

      // Up from where they woke, to Harkon: he greets them.
      const harkon = alias(sim, VQ02, HARKON);
      let topics: string[] | undefined;
      for (let i = 0; i < 20 && !topics; i++) {
        const at = await sim.position(harkon);
        if (at) await sim.walkPath(at, 2, 150);
        topics = await sim.listen(harkon, 0.5);
      }
      expect(sim.stageDone(TUTORIAL, 20)).toBe(true);
      expect(topics).toContain("I'm ready to learn about my new powers.");
      expect(await sim.choose(/ready to learn/)).toEqual([]);
      sim.goodbye();
      expect(await sim.until(() => sim.stageDone(TUTORIAL, 30), 20)).toBe(true);

      // His lesson: the player transforms, and lands when he tells them to (phase 6: "Do so
      // now"); he goes on to the end of it.
      const since = sim.time;
      expect(await sim.cast(power)).toBe(true);
      const beast = await sim.formId('RACE', 'DLC1VampireBeastRace');
      let race = await raceOf(sim);
      for (let i = 0; i < 10 && race !== beast; i++) {
        await sim.step(1);
        race = await raceOf(sim);
      }
      expect(race).toBe(beast);
      const phaseBegun = (index: number): boolean =>
        sim
          .records(since)
          .some(
            (record) =>
              record.kind === 'game' &&
              record.type === 'scene' &&
              record.event.scene === LESSON &&
              record.event.type === 'phaseBegin' &&
              record.event.index === index,
          );
      expect(await sim.until(() => phaseBegun(6), 120)).toBe(true);
      sim.press('Ready Weapon', true);
      await sim.step(0.2);
      sim.press('Ready Weapon', false);
      expect(await sim.until(() => sim.stageDone(TUTORIAL, 50), 240)).toBe(true);
      // No fight broke his lesson off.
      expect(phaseBegun(14)).toBe(true);
      expect(
        sim
          .records(since)
          .some(
            (record) =>
              record.kind === 'game' && record.type === 'combat' && record.event.actor === harkon,
          ),
      ).toBe(false);

      // His task: Bloodline done on the vampires' side.
      topics = undefined;
      for (let i = 0; i < 20 && !topics; i++) {
        const at = await sim.position(harkon);
        if (at) await sim.walkPath(at, 2, 150);
        topics = await sim.listen(harkon, 0.5);
      }
      expect(topics).toContain("I'm ready to carry out this task.");
      await sim.choose(/ready to carry out this task/);
      sim.goodbye();
      expect(await sim.until(() => sim.stageDone(VQ02, 200), 30)).toBe(true);
      expect(sim.stageDone(VQ02, 180)).toBe(true);
      expect(sim.stageDone(TUTORIAL, 200)).toBe(true);
      expect(sim.stageDone(HUNTER_INTRO, 20)).toBe(false);
    } finally {
      await sim.close();
    }
  }, 900_000);
});
