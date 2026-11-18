// Integration test: TG00 "A Chance Arrangement" on the headless simulation, played through as
// the player plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const TG00 = 0x21556;
const TG01 = 0x1f326;
/** TG00SP, the quest of Brynjolf's distraction, and its scenes. */
const TG00SP = 0x20be7;
/** TG00's Brynjolf and Brand-Shei aliases. */
const BRYNJOLF = 5;
const BRAND_SHEI = 10;
/** Madesi's strongbox under his stall (TG00MadesiChest) and his ring (TG00MadesiRingRef). */
const MADESI_CHEST = 0x76f14;
const RING_REF = 0xcdf65;
/** Riften's map marker (RiftenMapMarkerREF). */
const RIFTEN_MARKER = 0x1c390;
const GOLD = 0xf;
const LOCKPICK = 0xa;
/** How many times the player loads their save to try the plant again (each try is a chance). */
const PLANT_TRIES = 8;

/** The game with Brynjolf's job taken and his distraction begun (stage 10). */
let afterDeal: Uint8Array | undefined;
/** The game with Madesi's ring stolen, the distraction still on (stage 20). */
let afterRing: Uint8Array | undefined;
/** The game with the ring in Brand-Shei's pocket (stage 30). */
let afterPlant: Uint8Array | undefined;

/** The alias's reference in TG00. */
function alias(sim: Sim, id: number): number {
  return sim.runtime.state.quest(TG00).aliases.get(id) ?? 0;
}

describe.skipIf(!hasGamedata())('TG00 A Chance Arrangement', () => {
  // TG00 runs from the start. In Riften's market by day, Brynjolf greets a passer-by ("Running a
  // little light in the pockets"): his scheme (8: Madesi's ring to steal from the strongbox
  // under his stall and plant on Brand-Shei), and "I'm ready. Let's get this started." (10: his
  // distraction, TG00SP, and the Pickpocket boost on Brand-Shei).
  it("has Brynjolf offer the player a job in Riften's market (0-10)", async () => {
    const sim = await openSim({ hour: 10 });
    try {
      await sim.step(5);
      await sim.fastTravel(RIFTEN_MARKER, false);
      await sim.step(2);
      const brynjolf = alias(sim, BRYNJOLF);
      expect(brynjolf).not.toBe(0);
      const at = await sim.position(brynjolf);
      expect(at && (await sim.walkPath(at, 120, 150))).toBe(true);
      // His ForceGreet as the player comes near.
      expect(await sim.listen(brynjolf, 30)).toEqual(["I'm sorry, what?"]);
      await sim.choose(/I'm sorry, what/);
      await sim.choose(/How could you possibly/);
      expect(await sim.choose(/My wealth is none/)).toEqual(['What do you have in mind?']);
      await sim.choose(/What do you have in mind/);
      await sim.choose(/What do I have to do/);
      expect(await sim.choose(/Why plant the ring/)).toContain(
        "I'm ready. Let's get this started.",
      );
      expect(sim.stage(TG00)).toBe(8);
      await sim.choose(/I'm ready/);
      expect(sim.stage(TG00)).toBe(10);
      expect(sim.isRunning(TG00SP)).toBe(true);
      afterDeal = await sim.save('TG00 10');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Brynjolf calls the market together (TG00DistractionSetupScene: Madesi and Brand-Shei come to
  // watch) and sells his Falmer Blood Elixir (TG00DistractionScene). Behind Madesi's stall the
  // player picks the strongbox's lock and takes the ring (20).
  it("has the player steal Madesi's ring during Brynjolf's distraction (10-20)", async () => {
    if (!afterDeal) return;
    const sim = await loadSim(afterDeal);
    try {
      const distraction = await sim.formId('SCEN', 'TG00DistractionScene');
      expect(await sim.until(() => sim.runtime.scenes.isPlaying(distraction), 120)).toBe(true);
      const chest = await sim.position(MADESI_CHEST);
      expect(chest && (await sim.walkPath(chest, 60, 100))).toBe(true);
      const ring = (await sim.runtime.baseOf(RING_REF)) ?? 0;
      expect(await sim.runtime.itemCount(MADESI_CHEST, ring)).toBe(1);
      await sim.runtime.addItem(PLAYER_REF, sim.runtime.formHandle(LOCKPICK), 10, true);
      expect(await sim.pickLock(MADESI_CHEST)).toBe('opened');
      expect(await sim.take(MADESI_CHEST, ring)).toBe(true);
      expect(await sim.until(() => sim.stageDone(TG00, 20), 5)).toBe(true);
      afterRing = await sim.save('TG00 20');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Sneaking up to Brand-Shei while he watches, the player puts the ring in his pocket (30).
  // Each try is a pickpocket chance (TG00's boost added): caught, the player loads the save
  // and tries again.
  it("has the player plant the ring in Brand-Shei's pocket (20-30)", async () => {
    if (!afterRing) return;
    for (let attempt = 0; attempt < PLANT_TRIES && !afterPlant; attempt++) {
      // Another try: other dice (the seed), as in a game played again.
      const sim = await loadSim(afterRing, { seed: attempt + 1 });
      try {
        const brandShei = alias(sim, BRAND_SHEI);
        const ring = (await sim.runtime.baseOf(RING_REF)) ?? 0;
        const at = await sim.position(brandShei);
        expect(at && (await sim.walkPath(at, 60, 100))).toBe(true);
        if (!(await sim.pickpocket(brandShei, ring, true))) continue;
        expect(await sim.runtime.itemCount(brandShei, ring)).toBe(1);
        expect(await sim.until(() => sim.stageDone(TG00, 30), 5)).toBe(true);
        afterPlant = await sim.save('TG00 30');
      } finally {
        await sim.close();
      }
    }
    expect(afterPlant).toBeDefined();
  }, 1_800_000);

  // The distraction over, Brynjolf pays the player ("Looks like I chose the right person for
  // the job.") and sends them to the Ragged Flagon in the Ratway (200: TG00 done, TG01 begun).
  it('has Brynjolf pay the player and send them to the Ragged Flagon (30-200)', async () => {
    if (!afterPlant) return;
    const sim = await loadSim(afterPlant);
    try {
      const brynjolf = alias(sim, BRYNJOLF);
      const gold = await sim.runtime.itemCount(PLAYER_REF, GOLD);
      const at = await sim.position(brynjolf);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      expect(await sim.talk(brynjolf, 10)).toEqual(["What's been going on?"]);
      expect(await sim.runtime.itemCount(PLAYER_REF, GOLD)).toBeGreaterThan(gold);
      expect(await sim.choose(/What's been going on/)).toContain('I can handle it.');
      await sim.choose(/I can handle it/);
      expect(await sim.until(() => sim.stageDone(TG00, 200), 10)).toBe(true);
      expect(sim.isRunning(TG00)).toBe(false);
      expect(sim.stage(TG01)).toBe(10);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
