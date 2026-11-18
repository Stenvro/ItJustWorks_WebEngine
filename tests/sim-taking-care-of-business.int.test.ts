// Integration test: TG01 "Taking Care of Business" on the headless simulation, played through
// as the player plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const TG00 = 0x21556;
const TG01 = 0x1f326;
const TG02 = 0x2154e;
/** TG01's Brynjolf alias. */
const BRYNJOLF = 1;
/** Riften's map marker (RiftenMapMarkerREF). */
const RIFTEN_MARKER = 0x1c390;
/** The Ratway's door off Riften's canal, the Ratway (RiftenRatway01), its door to the Ragged
 * Flagon (TGRatwayDoorBeforeTG02) and the Flagon. */
const RATWAY_DOOR = 0x48fa0;
const RATWAY = 0x3b698;
const RATWAY_TO_FLAGON = 0xa1e20;
const RAGGED_FLAGON = 0x16bcf;
/** The doors back: the Flagon's to the Ratway (DoorRaggedFlagonToRatwayBeforeTG02), the
 * Ratway's to Riften's canal. */
const FLAGON_TO_RATWAY = 0x16d2e;
const RATWAY_TO_RIFTEN = 0xa3de1;
/** The Bee and Barb's door from the street, the inn, and its door to the street. */
const BEE_AND_BARB_DOOR = 0x42279;
const BEE_AND_BARB = 0x16bdf;
const BEE_AND_BARB_EXIT = 0x16c3c;
/** Haelga's Bunkhouse's door from the street, the bunkhouse, its door out. */
const BUNKHOUSE_DOOR = 0x42278;
const BUNKHOUSE = 0x16bd4;
const BUNKHOUSE_EXIT = 0x16cde;
/** The Pawned Prawn's door from the street, the shop, its door out. */
const PAWNED_PRAWN_DOOR = 0x4228d;
const PAWNED_PRAWN = 0x16bd9;
const PAWNED_PRAWN_EXIT = 0x16c8e;
/** TG01's Keerava, Bersi, Haelga and Talen-Jei aliases. */
const KEERAVA = 2;
const BERSI = 3;
const HAELGA = 4;
const TALEN_JEI = 10;
/** Haelga's Statue of Dibella (TG01HaelgaStatueRef) and its base. */
const STATUE_REF = 0x10cc69;
const STATUE = 0x21ea3;
const GOLD = 0xf;

/** The game with Brynjolf's job given: the three debts to collect (stage 20). */
let afterJob: Uint8Array | undefined;
/** The game with Keerava's debt collected (stage 30). */
let afterKeerava: Uint8Array | undefined;
/** The game with all three debts collected (stage 50). */
let afterDebts: Uint8Array | undefined;

/** The alias's reference in TG01. */
function alias(sim: Sim, id: number): number {
  return sim.runtime.state.quest(TG01).aliases.get(id) ?? 0;
}

/** Those fighting the player fall to the player's blows (TODO(M13): the player's own blows). */
async function fendOff(sim: Sim): Promise<void> {
  for (const staged of sim.actors()) {
    const actor = staged.reference;
    if (actor === PLAYER_REF || staged.dead) continue;
    if (sim.world.stage.combat.targetOf(actor) === PLAYER_REF) await sim.kill(actor, PLAYER_REF);
  }
}

/** The player walks to a point a few seconds at a time, fighting off those who attack. */
async function walkFighting(
  sim: Sim,
  target: readonly [number, number, number],
  seconds: number,
  reach: number,
): Promise<boolean> {
  const until = sim.time + seconds;
  while (sim.time < until) {
    const started = sim.time;
    const there = await sim.walkPath([...target], Math.min(5, until - sim.time), reach);
    await fendOff(sim);
    if (there) return true;
    if (sim.time === started) await sim.step(0.5);
  }
  return false;
}

/** The player walks to a door and goes through it. */
async function through(sim: Sim, door: number, cell?: number): Promise<void> {
  const at = await sim.position(door);
  expect(at && (await walkFighting(sim, at, 240, 100))).toBe(true);
  expect(sim.activate(door)).toBe(true);
  await sim.world.settle();
  await sim.step(1);
  if (cell !== undefined) expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(cell);
}

describe.skipIf(!hasGamedata())('TG01 Taking Care of Business', () => {
  // TG00 done (its end begins TG01: 10, "Locate Brynjolf at the Ragged Flagon"). Down the Ratway
  // to the Flagon, where Brynjolf waits: "So this is the Ragged Flagon?" and his job, three
  // shopkeepers' debts (20).
  it('has the player find Brynjolf in the Ragged Flagon and take his job (10-20)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      await sim.step(5);
      void sim.runtime.quests.setStage(TG00, 200);
      expect(await sim.until(() => sim.stage(TG01) === 10, 30)).toBe(true);
      await sim.fastTravel(RIFTEN_MARKER, false);
      await sim.step(2);
      await through(sim, RATWAY_DOOR, RATWAY);
      await through(sim, RATWAY_TO_FLAGON, RAGGED_FLAGON);
      const brynjolf = alias(sim, BRYNJOLF);
      const at = await sim.position(brynjolf);
      expect(at && (await walkFighting(sim, at, 90, 150))).toBe(true);
      const listed = await sim.converse(brynjolf, [
        /So this is the Ragged Flagon/,
        /Getting here was easy/,
        /Deadbeats/,
        /Who are they/,
        /How did you want me to handle it/,
        /Consider it done/,
      ]);
      expect(listed).toContain('Any tips about Keerava?');
      expect(sim.stage(TG01)).toBe(20);
      afterJob = await sim.save('TG01 20');
    } finally {
      await sim.close();
    }
  }, 900_000);

  // Keerava, at the Bee and Barb, will not pay. Talen-Jei, her betrothed, tells of her family's
  // farm in Morrowind ("You might want to talk some sense into Keerava."); told of it, she pays
  // (30).
  it("has the player collect Keerava's debt through Talen-Jei (20-30)", async () => {
    if (!afterJob) return;
    const sim = await loadSim(afterJob);
    try {
      await through(sim, FLAGON_TO_RATWAY, RATWAY);
      await through(sim, RATWAY_TO_RIFTEN);
      await through(sim, BEE_AND_BARB_DOOR, BEE_AND_BARB);
      const talenJei = alias(sim, TALEN_JEI);
      let at = await sim.position(talenJei);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      // His blocking topic is offered alone; his secret told, it is not offered again.
      expect(await sim.converse(talenJei, [/talk some sense/, /help me convince/])).not.toContain(
        'You might want to talk some sense into Keerava.',
      );
      const keerava = alias(sim, KEERAVA);
      at = await sim.position(keerava);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      const gold = await sim.runtime.itemCount(PLAYER_REF, GOLD);
      await sim.converse(keerava, [/ready to pay/, /farm in Morrowind/, /pay up/]);
      expect(sim.stageDone(TG01, 30)).toBe(true);
      expect(await sim.runtime.itemCount(PLAYER_REF, GOLD)).toBeGreaterThan(gold);
      await through(sim, BEE_AND_BARB_EXIT);
      afterKeerava = await sim.save('TG01 30');
    } finally {
      await sim.close();
    }
  }, 900_000);

  // Haelga, at her bunkhouse: the player takes her Statue of Dibella from its shrine, and with it
  // in hand she pays ("So, should I drop this statue down a well?": 45). Bersi Honey-Hand, at the
  // Pawned Prawn, has heard how the other two were made to pay (GotCash 2) and pays at the
  // message ("Oh! There's no need for that.": 40). All three paid: back to Brynjolf (50).
  it('has the player collect Haelga and Bersi Honey-Hand (45, 40, 50)', async () => {
    if (!afterKeerava) return;
    const sim = await loadSim(afterKeerava);
    try {
      await through(sim, BUNKHOUSE_DOOR, BUNKHOUSE);
      const statue = await sim.position(STATUE_REF);
      expect(statue && (await sim.walkPath(statue, 60, 100))).toBe(true);
      expect(await sim.pickUp(STATUE_REF)).toBe(true);
      expect(await sim.runtime.itemCount(PLAYER_REF, STATUE)).toBe(1);
      const haelga = alias(sim, HAELGA);
      let at = await sim.position(haelga);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      await sim.converse(haelga, [/message from Brynjolf/, /drop this statue/]);
      expect(sim.stageDone(TG01, 45)).toBe(true);
      await through(sim, BUNKHOUSE_EXIT);
      await through(sim, PAWNED_PRAWN_DOOR, PAWNED_PRAWN);
      const bersi = alias(sim, BERSI);
      at = await sim.position(bersi);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      const gold = await sim.runtime.itemCount(PLAYER_REF, GOLD);
      await sim.converse(bersi, [/message from Brynjolf/]);
      expect(sim.stageDone(TG01, 40)).toBe(true);
      expect(await sim.runtime.itemCount(PLAYER_REF, GOLD)).toBeGreaterThan(gold);
      expect(sim.stage(TG01)).toBe(50);
      afterDebts = await sim.save('TG01 50');
    } finally {
      await sim.close();
    }
  }, 900_000);

  // Back in the Flagon: "Here's what they owed us." Brynjolf's next job ("If there's more gold
  // where that came from, I'm in."): TG01 done (200), TG02 begun.
  it('has Brynjolf take the debts and offer more work (50-200)', async () => {
    if (!afterDebts) return;
    const sim = await loadSim(afterDebts);
    try {
      await through(sim, PAWNED_PRAWN_EXIT);
      await through(sim, RATWAY_DOOR, RATWAY);
      await through(sim, RATWAY_TO_FLAGON, RAGGED_FLAGON);
      const brynjolf = alias(sim, BRYNJOLF);
      const at = await sim.position(brynjolf);
      expect(at && (await walkFighting(sim, at, 90, 150))).toBe(true);
      const listed = await sim.converse(brynjolf, [
        /what they owed/,
        /What's next/,
        /more gold/,
        /Before we go/,
        /outfit isn't doing well/,
        /Fair enough/,
      ]);
      expect(listed).toEqual([]);
      expect(await sim.until(() => sim.stageDone(TG01, 200), 10)).toBe(true);
      expect(sim.stage(TG02)).toBeGreaterThanOrEqual(10);
    } finally {
      await sim.close();
    }
  }, 900_000);
});
