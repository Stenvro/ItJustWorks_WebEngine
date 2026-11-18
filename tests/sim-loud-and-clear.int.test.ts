// Integration test: TG02 "Loud and Clear" on the headless simulation, played through as the
// player plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const TG02 = 0x2154e;

/** TG02's Brynjolf and Mercer Frey aliases. */
const BRYNJOLF = 0;
const MERCER = 1;
/** TG02's Aringoth and bill of sale aliases. */
const ARINGOTH = 2;
const BILL_OF_SALE = 4;
/** TG03 "Dampened Spirits", which TG02's end begins. */
const TG03 = 0x2154f;
/** Goldenglow's map marker (GoldenglowMapMarkerRef) and its six hives (TG02BeeHive). */
const GOLDENGLOW_MARKER = 0x1a710;
const HIVES = [0x25d95, 0x25d97, 0xa31e5, 0x9ec17, 0xa31e6, 0xa31e7];
/** The estate's front door (Expert, no key), its door upstairs, and back down to the cellar. */
const ESTATE_DOOR = 0xbccb4;
const ESTATE_UPSTAIRS = 0x2d4a9;
const ESTATE_DOWNSTAIRS = 0x2d4aa;
const ESTATE_CELLAR = 0x2d4a7;
/** The estate's ground floor, its upper floor and its cellar (GoldenglowEstate01/02/03). */
const ESTATE = 0x161ff;
const ESTATE_UPPER = 0x2d3e8;
const ESTATE_LOWER = 0x2d3e7;
/** Aringoth's safe (TG02AringothSafe: Expert) and its key (TG02GoldenglowSafeKey). */
const SAFE = 0x4c6c9;
const SAFE_KEY = 0xe6dfe;
/** The player's own spell of fire (Flames) and the lockpick (Lockpick). */
const FLAMES = 0x12fcd;
const LOCKPICK = 0xa;
/** Gold (Gold001). */
const GOLD = 0xf;
/** Riften's map marker (RiftenMapMarkerREF). */
const RIFTEN_MARKER = 0x1c390;
/** The Ratway's door off Riften's canal, the Ratway, its door to the Ragged Flagon and the
 * Flagon. */
const RATWAY_DOOR = 0x48fa0;
const RATWAY = 0x3b698;
const RATWAY_TO_FLAGON = 0xa1e20;
const RAGGED_FLAGON = 0x16bcf;
/** The Flagon's door to the Cistern, the Guild's home (RiftenThievesGuildHeadquarters). */
const FLAGON_TO_CISTERN = 0x25d83;
const CISTERN = 0x16bd0;

/** The alias's reference in TG02. */
function alias(sim: Sim, id: number): number {
  return sim.runtime.state.quest(TG02).aliases.get(id) ?? 0;
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

/**
 * The player follows an actor a while: walking after it, and through the door it took (`doors`:
 * the door the way leaves each place by, by the place's form id).
 */
async function follow(
  sim: Sim,
  leader: number,
  seconds: number,
  done: () => boolean,
  doors: ReadonlyMap<number, number>,
): Promise<void> {
  const until = sim.time + seconds;
  while (sim.time < until && !done()) {
    const [here, there] = await Promise.all([
      sim.runtime.placement(PLAYER_REF),
      sim.runtime.placement(leader),
    ]);
    const space = (p: typeof here): number | undefined => p?.cell ?? p?.world;
    const door = doors.get(space(here) ?? 0);
    if (there && space(there) !== space(here) && door !== undefined) {
      await through(sim, door);
      continue;
    }
    const started = sim.time;
    const at = await sim.position(leader);
    if (at) await sim.walkPath(at, 2, 150);
    // A walk that found no way (or was there already) takes no step: time goes on.
    if (sim.time === started) await sim.step(0.5);
  }
}

/** The game with the Goldenglow job given (stage 40). */
let afterJob: Uint8Array | undefined;
/** The game with Aringoth's safe cleared (stage 50). */
let afterSafe: Uint8Array | undefined;

describe.skipIf(!hasGamedata())('TG02 Loud and Clear', () => {
  // TG02's own start for a game that skips ahead (0: TG00 and TG01 done, Brynjolf at his
  // start): 10, "Follow Brynjolf". In the Flagon he leads the player into the Cistern, the
  // Guild's home (20), where Mercer Frey questions the newcomer (TG02IntroScene) and Brynjolf
  // gives the Goldenglow job (40).
  it('has Brynjolf bring the player to Mercer Frey in the Cistern (10-40)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      await sim.step(5);
      void sim.runtime.quests.setStage(TG02, 0);
      expect(await sim.until(() => sim.stage(TG02) === 10, 30)).toBe(true);
      await sim.fastTravel(RIFTEN_MARKER, false);
      await sim.step(2);
      await through(sim, RATWAY_DOOR, RATWAY);
      await through(sim, RATWAY_TO_FLAGON, RAGGED_FLAGON);
      const brynjolf = alias(sim, BRYNJOLF);
      const at = await sim.position(brynjolf);
      expect(at && (await walkFighting(sim, at, 90, 150))).toBe(true);
      expect(sim.package(brynjolf)?.procedure).toBe('Escort');
      await follow(
        sim,
        brynjolf,
        120,
        () => sim.stageDone(TG02, 20),
        new Map([[RAGGED_FLAGON, FLAGON_TO_CISTERN]]),
      );
      expect(sim.stageDone(TG02, 20)).toBe(true);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(CISTERN);
      // Brynjolf presents the newcomer; Mercer questions them, then forcegreets the player
      // (TG02IntroScene's last phase): the rules. "Yes, I understand." starts TG02IntroScene02,
      // whose end sets 30.
      const mercer = alias(sim, MERCER);
      expect(await sim.listen(mercer, 120)).toContain('Yes, I understand.');
      await sim.choose(/Rules\?/);
      expect(await sim.choose(/Yes, I understand/)).toEqual([]);
      expect(await sim.until(() => sim.stageDone(TG02, 30), 180)).toBe(true);
      // Brynjolf's forcegreet: the cut (35), the Goldenglow job, its catch (40).
      expect(await sim.listen(brynjolf, 30)).toEqual(['So how do I get my cut of the spoils?']);
      await sim.choose(/cut of the spoils/);
      expect(sim.stage(TG02)).toBe(35);
      await sim.choose(/Goldenglow job/);
      await sim.choose(/catch/);
      await sim.choose(/Makes sense/);
      await sim.choose(/Aringoth/);
      expect(sim.stage(TG02)).toBe(40);
      sim.goodbye();
      afterJob = await sim.save('TG02 40');
    } finally {
      await sim.close();
    }
  }, 900_000);

  // Goldenglow Estate, on its island in Lake Honrich: over the bridges past the mercenaries (who
  // fight the player), three of its six hives burnt with Flames (TrapExplosiveGas: a fire hit
  // sets one off; TG02HiveCount counts them, the first brings the hives' reinforcements), the
  // front door's Expert lock picked. Aringoth, upstairs, will not give up his safe's key ("Then
  // I'll take it off your corpse!": he fights, and falls), and the safe in the cellar opens with
  // it. The bill of sale taken: the job done (50).
  it("has the player burn the hives and clear Aringoth's safe (40-50)", async () => {
    if (!afterJob) return;
    const sim = await loadSim(afterJob);
    try {
      const hiveCount = await sim.formId('GLOB', 'TG02HiveCount');
      const burnt = (): number => sim.runtime.state.globals.get(hiveCount) ?? 0;
      await sim.fastTravel(GOLDENGLOW_MARKER, false);
      await sim.step(2);
      expect(await sim.equip(FLAMES)).toBe(true);
      for (const hive of HIVES) {
        if (burnt() >= 3) break;
        const at = await sim.position(hive);
        if (!at || !(await walkFighting(sim, at, 120, 300))) continue;
        sim.look([at[0], at[1], at[2] + 30]);
        await sim.attack(2.5);
        await sim.step(2);
        await fendOff(sim);
      }
      expect(burnt()).toBe(3);
      // The front door: an Expert lock with no key.
      expect(await sim.runtime.itemCount(PLAYER_REF, LOCKPICK)).toBeGreaterThan(0);
      const door = await sim.position(ESTATE_DOOR);
      expect(door && (await walkFighting(sim, door, 180, 100))).toBe(true);
      expect(await sim.pickLock(ESTATE_DOOR)).toBe('opened');
      await through(sim, ESTATE_DOOR, ESTATE);
      await through(sim, ESTATE_UPSTAIRS, ESTATE_UPPER);
      const aringoth = alias(sim, ARINGOTH);
      const at = await sim.position(aringoth);
      expect(at && (await walkFighting(sim, at, 90, 320))).toBe(true);
      expect(await sim.talk(aringoth, 10)).toContain('I just want the key to your safe.');
      await sim.choose(/key to your safe/);
      expect(await sim.choose(/take it off your corpse/)).toEqual([]);
      const fights = (): boolean => sim.world.stage.combat.targetOf(aringoth) === PLAYER_REF;
      expect(await sim.until(fights, 30)).toBe(true);
      await fendOff(sim);
      expect(sim.actor(aringoth)?.dead).toBe(true);
      expect(await sim.take(aringoth, SAFE_KEY)).toBe(true);
      await through(sim, ESTATE_DOWNSTAIRS, ESTATE);
      await through(sim, ESTATE_CELLAR, ESTATE_LOWER);
      const safe = await sim.position(SAFE);
      expect(safe && (await walkFighting(sim, safe, 90, 120))).toBe(true);
      // The key opens it, as the lock does for a player who holds its key.
      expect(await sim.pickLock(SAFE)).toBe('key');
      expect((await sim.runtime.lock(SAFE)).locked).toBe(false);
      const bill = (await sim.runtime.baseOf(alias(sim, BILL_OF_SALE))) ?? 0;
      expect(await sim.take(SAFE, bill)).toBe(true);
      expect(await sim.until(() => sim.stage(TG02) === 50, 10)).toBe(true);
      afterSafe = await sim.save('TG02 50');
    } finally {
      await sim.close();
    }
  }, 900_000);

  // Back to Brynjolf: "Yes, and here's what was in the safe." His word on Maven Black-Briar, the
  // pay: TG02 done (200), TG03 begun (10).
  it('has Brynjolf take the bill of sale and send the player to Maven (50-200)', async () => {
    if (!afterSafe) return;
    const sim = await loadSim(afterSafe);
    try {
      await sim.fastTravel(RIFTEN_MARKER, false);
      await sim.step(2);
      await through(sim, RATWAY_DOOR, RATWAY);
      await through(sim, RATWAY_TO_FLAGON, RAGGED_FLAGON);
      const brynjolf = alias(sim, BRYNJOLF);
      if ((await sim.runtime.placement(brynjolf))?.cell === CISTERN) {
        await through(sim, FLAGON_TO_CISTERN, CISTERN);
      }
      const at = await sim.position(brynjolf);
      expect(at && (await walkFighting(sim, at, 120, 150))).toBe(true);
      // The safe's papers (the bill of sale goes to him), the symbol on them, Maven; then the pay
      // ("Speaking of which...": TG02QuestScript.Rewarded, a leveled reward).
      const gold = await sim.runtime.itemCount(PLAYER_REF, GOLD);
      const bill = (await sim.runtime.baseOf(alias(sim, BILL_OF_SALE))) ?? 0;
      expect(await sim.runtime.itemCount(PLAYER_REF, bill)).toBe(1);
      const listed = await sim.converse(brynjolf, [
        /what was in the safe/,
        /No idea/,
        /about time I met her/,
        /What does Maven want/,
        /Speaking of which/,
      ]);
      expect(listed).toEqual([]);
      expect(await sim.until(() => sim.stageDone(TG02, 200), 30)).toBe(true);
      expect(sim.stage(TG03)).toBeGreaterThanOrEqual(10);
      expect(await sim.runtime.itemCount(PLAYER_REF, bill)).toBe(0);
      expect(await sim.runtime.itemCount(PLAYER_REF, GOLD)).toBeGreaterThan(gold);
    } finally {
      await sim.close();
    }
  }, 900_000);
});
