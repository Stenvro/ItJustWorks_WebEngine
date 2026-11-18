// Integration test: TG03 "Dampened Spirits" on the headless simulation, played through as the
// player plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const TG03 = 0x2154f;

/** TG03's Maven Black-Briar, Mallus Maccius and Sabjorn aliases. */
const MAVEN = 1;
const MALLUS = 4;
const SABJORN = 6;
/** The vat's lid, the skeevers' nest, Sabjorn's chest and the letter in it (TG03's aliases). */
const VAT = 9;
const NEST = 12;
const SABJORN_CHEST = 15;
const SABJORN_LETTER = 16;
/** The poison Sabjorn gives (TG03Poison, made in the holding safe: alias 20). */
const POISON = 20;
/** Honningbrew Meadery's map marker (HonningbrewMeaderyMapMarker). */
const MEADERY_MARKER = 0x38593;
/** The tasting ceremony (TG03SP's TG03SPMeadScene). */
const MEAD_SCENE = 0x549f4;
/** Riften's map marker (RiftenMapMarkerREF). */
const RIFTEN_MARKER = 0x1c390;
/** TG03's Brynjolf alias; TG04 "Scoundrel's Folly", which TG03's end begins. */
const BRYNJOLF = 0;
const TG04 = 0x21550;
/** The Ratway's door off Riften's canal, its door to the Ragged Flagon, the Flagon's to the
 * Cistern; the Flagon and the Cistern. */
const RATWAY_DOOR = 0x48fa0;
const RATWAY_TO_FLAGON = 0xa1e20;
const FLAGON_TO_CISTERN = 0x25d83;
const RAGGED_FLAGON = 0x16bcf;
const CISTERN = 0x16bd0;
/** The Flagon's secret door on the way to the Cistern (TGFlagonSecretDoorRef). */
const FLAGON_SECRET_DOOR = 0xc19c0;

/** The alias's reference in TG03. */
function alias(sim: Sim, id: number): number {
  return sim.runtime.state.quest(TG03).aliases.get(id) ?? 0;
}

/** Those fighting the player fall to the player's blows (TODO(M13): the player's own blows). */
async function fendOff(sim: Sim): Promise<void> {
  for (const staged of sim.actors()) {
    const actor = staged.reference;
    if (actor === PLAYER_REF || staged.dead) continue;
    if (sim.world.stage.combat.targetOf(actor) === PLAYER_REF) await sim.kill(actor, PLAYER_REF);
  }
}

/**
 * The player talks to an actor, each time taking the first topic listed that matches one of
 * `topics` (in the order the patterns are given) until `done` holds or none matches.
 */
async function talkUntil(
  sim: Sim,
  actor: number,
  topics: readonly RegExp[],
  done: () => boolean,
): Promise<void> {
  let listed = (await sim.talk(actor, 10)) ?? [];
  for (let turn = 0; turn < 12 && !done(); turn++) {
    const pattern = topics.find((each) => listed.some((text) => each.test(text)));
    if (!pattern) break;
    listed = await sim.choose(pattern);
  }
  sim.goodbye();
}

/** The player walks to a door and goes through it. */
async function through(sim: Sim, door: number, cell?: number): Promise<void> {
  const at = await sim.position(door);
  let there = false;
  for (let tries = 0; tries < 24 && at && !there; tries++) {
    there = await sim.walkPath(at, 10, 100);
    await fendOff(sim);
  }
  expect(there).toBe(true);
  expect(sim.activate(door)).toBe(true);
  await sim.world.settle();
  await sim.step(1);
  if (cell !== undefined) expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(cell);
}

/** The game with Maven's job given: Honningbrew Meadery (stage 20). */
let afterMaven: Uint8Array | undefined;
/** The game with Mallus's plan told (30), Sabjorn's job taken (40), the vat poisoned (60). */
let afterMallus: Uint8Array | undefined;
let afterSabjorn: Uint8Array | undefined;
let afterVat: Uint8Array | undefined;
/** The game with Sabjorn's letter taken: back to Maven (100). */
let afterLetter: Uint8Array | undefined;

describe.skipIf(!hasGamedata())('TG03 Dampened Spirits', () => {
  // TG03's own start for a game that skips ahead (0: the player in the Guild, TG02 done): 10,
  // "Speak to Maven Black-Briar". In Riften she sizes up the newcomer and sends them to Whiterun:
  // Honningbrew Meadery, its owner Sabjorn, and Mallus Maccius, who waits for them there (20).
  it('has Maven Black-Briar send the player to Honningbrew Meadery (10-20)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      await sim.step(5);
      void sim.runtime.quests.setStage(TG03, 0);
      expect(await sim.until(() => sim.stage(TG03) === 10, 30)).toBe(true);
      // The Flagon's secret door to the Cistern (TGFlagonSecretDoorRef: a lock no key opens) as
      // TG02 leaves it, open to the Guild (sim-loud-and-clear walks through it): the skip-ahead
      // start does not open it. TODO(M13): which of TG02's scripts unlocks it, read from them.
      await sim.runtime.setLocked(FLAGON_SECRET_DOOR, false);
      await sim.fastTravel(RIFTEN_MARKER, false);
      await sim.step(2);
      const maven = alias(sim, MAVEN);
      expect(await sim.travelTo(maven, 240, 150, () => fendOff(sim))).toBe(true);
      const listed = await sim.converse(maven, [
        /Brynjolf said you wanted to see me/,
        /best at what I do/,
        /no faith in the Guild/,
        /won't have that problem/,
        /Where do I begin/,
      ]);
      expect(listed).toContain('Who runs the show at Honningbrew Meadery?');
      sim.goodbye();
      expect(sim.stage(TG03)).toBe(20);
      afterMaven = await sim.save('TG03 20');
    } finally {
      await sim.close();
    }
  }, 900_000);

  // Mallus Maccius waits in Whiterun's Bannered Mare: "Maven said you're expecting me." The plan
  // (Sabjorn's skeevers, the poison, the tasting): 30.
  it('has Mallus Maccius tell the plan in the Bannered Mare (20-30)', async () => {
    if (!afterMaven) return;
    const sim = await loadSim(afterMaven);
    try {
      await sim.fastTravel(MEADERY_MARKER, false);
      await sim.step(2);
      const mallus = alias(sim, MALLUS);
      expect(await sim.travelTo(mallus, 480, 150, () => fendOff(sim))).toBe(true);
      await sim.converse(mallus, [
        /Maven said you're expecting me/,
        /You have the poison/,
        /How do I fit in/,
        /Clever/,
      ]);
      sim.goodbye();
      expect(sim.stage(TG03)).toBe(30);
      afterMallus = await sim.save('TG03 30');
    } finally {
      await sim.close();
    }
  }, 900_000);

  // Back at the meadery Sabjorn has a skeever problem: "I might be able to help." Paid when the
  // job is done, he hands over the poison for the nest (40).
  it('has Sabjorn hire the player against the skeevers (30-40)', async () => {
    if (!afterMallus) return;
    const sim = await loadSim(afterMallus);
    try {
      await sim.fastTravel(MEADERY_MARKER, false);
      await sim.step(2);
      const sabjorn = alias(sim, SABJORN);
      expect(await sim.travelTo(sabjorn, 300, 150, () => fendOff(sim))).toBe(true);
      await sim.converse(sabjorn, [
        /Is something wrong/,
        /I might be able to help/,
        /Just pay me when the job's done/,
        /permanently/,
        /You've got a deal/,
      ]);
      sim.goodbye();
      expect(sim.stage(TG03)).toBe(40);
      const poison = (await sim.runtime.baseOf(alias(sim, POISON))) ?? 0;
      expect(await sim.runtime.itemCount(PLAYER_REF, poison)).toBe(1);
      afterSabjorn = await sim.save('TG03 40');
    } finally {
      await sim.close();
    }
  }, 900_000);

  // Down in the boilery's tunnels past the skeevers (and the one who lives with them): the
  // nest poisoned (45), then on through the door to the brewery and the vat (55, 60).
  it('has the player poison the nest and the vat (40-60)', async () => {
    if (!afterSabjorn) return;
    const sim = await loadSim(afterSabjorn);
    try {
      const nest = alias(sim, NEST);
      expect(await sim.travelTo(nest, 480, 120, () => fendOff(sim))).toBe(true);
      await fendOff(sim);
      expect(sim.activate(nest)).toBe(true);
      expect(await sim.until(() => sim.stage(TG03) === 45, 10)).toBe(true);
      const vat = alias(sim, VAT);
      expect(await sim.travelTo(vat, 300, 120, () => fendOff(sim))).toBe(true);
      expect(sim.activate(vat)).toBe(true);
      expect(await sim.until(() => sim.stage(TG03) === 60, 10)).toBe(true);
      expect(sim.stageDone(TG03, 55)).toBe(true);
      afterVat = await sim.save('TG03 60');
    } finally {
      await sim.close();
    }
  }, 900_000);

  // "Job's finished." Sabjorn pays (70) and the tasting begins: the Captain of the Guard drinks,
  // falls ill and has Sabjorn taken away (TG03SPMeadScene: 80). Mallus, the new owner, has the
  // key to Sabjorn's books (90); in his chest the letter with the symbol (100).
  it('has the tasting ceremony ruin Sabjorn and his chest give up the letter (60-100)', async () => {
    if (!afterVat) return;
    const sim = await loadSim(afterVat);
    try {
      const sabjorn = alias(sim, SABJORN);
      expect(await sim.travelTo(sabjorn, 300, 150, () => fendOff(sim))).toBe(true);
      await sim.converse(sabjorn, [/Job's finished/, /What about my pay/]);
      sim.goodbye();
      expect(sim.stage(TG03)).toBe(70);
      expect(await sim.until(() => sim.runtime.scenes.isPlaying(MEAD_SCENE), 30)).toBe(true);
      expect(await sim.until(() => sim.stage(TG03) >= 80, 420)).toBe(true);
      const mallus = alias(sim, MALLUS);
      expect(await sim.travelTo(mallus, 120, 150, () => fendOff(sim))).toBe(true);
      await sim.converse(mallus, [/look at Sabjorn's books/]);
      sim.goodbye();
      expect(sim.stage(TG03)).toBe(90);
      const chest = alias(sim, SABJORN_CHEST);
      expect(await sim.travelTo(chest, 120, 120, () => fendOff(sim))).toBe(true);
      // Its lock wants its key (Mallus's): the lock opens for the player who holds it.
      expect(await sim.pickLock(chest)).toBe('key');
      const letter = (await sim.runtime.baseOf(alias(sim, SABJORN_LETTER))) ?? 0;
      expect(await sim.take(chest, letter)).toBe(true);
      expect(await sim.until(() => sim.stage(TG03) === 100, 10)).toBe(true);
      afterLetter = await sim.save('TG03 100');
    } finally {
      await sim.close();
    }
  }, 900_000);

  // Maven in Riften: "Job's finished. Here's the information you requested." The symbol on the
  // letter (110). Brynjolf in the Cistern hears of it: TG03 done (200), TG04 begun.
  it('has Maven and Brynjolf hear of the symbol (100-200)', async () => {
    if (!afterLetter) return;
    const sim = await loadSim(afterLetter);
    try {
      await sim.fastTravel(RIFTEN_MARKER, false);
      await sim.step(2);
      const maven = alias(sim, MAVEN);
      expect(await sim.travelTo(maven, 300, 150, () => fendOff(sim))).toBe(true);
      await sim.converse(maven, [/information you requested/, /seen that symbol before/]);
      sim.goodbye();
      expect(sim.stage(TG03)).toBe(110);
      // To the Ratway from the city's gate (TODO(M13): walked from the Bee and Barb's door, the
      // player's way down to the canal holds them against a wall by the market, 2,000 units off).
      await sim.fastTravel(RIFTEN_MARKER, false);
      await sim.step(2);
      await through(sim, RATWAY_DOOR);
      await through(sim, RATWAY_TO_FLAGON, RAGGED_FLAGON);
      const brynjolf = alias(sim, BRYNJOLF);
      if ((await sim.runtime.placement(brynjolf))?.cell === CISTERN) {
        await through(sim, FLAGON_TO_CISTERN, CISTERN);
      }
      const at = await sim.position(brynjolf);
      expect(at && (await sim.walkPath(at, 90, 150))).toBe(true);
      await talkUntil(
        sim,
        brynjolf,
        [/same symbol/, /anything we can do/, /fortunate for Maven/],
        () => sim.stageDone(TG03, 200),
      );
      expect(await sim.until(() => sim.stageDone(TG03, 200), 30)).toBe(true);
      expect(sim.stage(TG04)).toBeGreaterThanOrEqual(10);
    } finally {
      await sim.close();
    }
  }, 900_000);
});
