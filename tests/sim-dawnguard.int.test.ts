// Integration test: DLC1VQ01MiscObjective "Dawnguard" on the headless simulation, played through
// as the player plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

/** DLC1VQ01MiscObjective "Dawnguard" and DLC1VQ00, the recruiter's quest. */
const DAWNGUARD = 0x200d06c;
const VQ00 = 0x200d90e;
/** DLC1VQ01 "Awakening". */
const VQ01 = 0x200352a;
/** DLC1VQ00's Messenger and LocationCenterMarker aliases; DLC1VQ01MiscObjective's Isran alias. */
const MESSENGER = 3;
const LOCATION_CENTRE = 2;
const ISRAN = 2;
/** DLC1VQMinLevel: the level the recruiters wait for. */
const MIN_LEVEL = 0x200d912;
const RIVERWOOD_MARKER = 0x162a4;
/** DLC1DawnguardMapMarkerMain, the fort's door (DLC1DawnguardHQDoorRef) and its hall. */
const FORT_MARKER = 0x2013f21;
const FORT_DOOR = 0x2002100;
const FORT_HALL = 0x2001dba;

/** The game with the player sent to Fort Dawnguard (DLC1VQ01MiscObjective 10). */
let toldOfFort: Uint8Array | undefined;

/** A quest alias's reference. */
function alias(sim: Sim, quest: number, id: number): number {
  return sim.runtime.state.quest(quest).aliases.get(id) ?? 0;
}

describe.skipIf(!hasGamedata())('DLC1VQ01MiscObjective Dawnguard', () => {
  // A player of the level the Dawnguard looks for (DLC1VQMinLevel) comes into a town: the story
  // manager's change of location (DLC1VQ00Node) sends Durak there (DLC1VQ00ChangeLocation), who
  // comes to them as they walk in ("You there. The Dawnguard is looking for anyone willing...")
  // and sends them to Isran at Fort Dawnguard ("Killing vampires? Where do I sign up?": DLC1VQ00
  // 50, the misc objective's 10).
  it('has the recruiter send the player to Fort Dawnguard (DLC1VQ00 50)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      const level = sim.runtime.state.globals.get(MIN_LEVEL) ?? 10;
      sim.runtime.state.actor(PLAYER_REF).level = level;
      await sim.fastTravel(RIVERWOOD_MARKER);
      expect(await sim.until(() => sim.stageDone(DAWNGUARD, 5), 30)).toBe(true);
      const durak = alias(sim, VQ00, MESSENGER);
      expect(durak).not.toBe(0);
      // Into the town, where Durak waits (his ForceGreet's trigger is round the town's centre).
      const centre = await sim.position(alias(sim, VQ00, LOCATION_CENTRE));
      expect(centre).toBeDefined();
      if (centre) await sim.walkPath(centre, 60, 1500);
      expect(await sim.listen(durak, 120)).toContain('Killing vampires? Where do I sign up?');
      await sim.choose(/Where do I sign up/);
      sim.goodbye();
      await sim.step(1);
      expect(sim.stageDone(VQ00, 50)).toBe(true);
      expect(sim.stageDone(DAWNGUARD, 10)).toBe(true);
      expect(sim.runtime.state.quest(DAWNGUARD).objectives.get(10)?.displayed).toBe(true);
      expect(alias(sim, DAWNGUARD, ISRAN)).not.toBe(0);
      toldOfFort = await sim.save('Dawnguard 10');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // To Fort Dawnguard (the way there is not under test) and in at its door: Celann greets the
  // newcomer (DLC1VQ01IsranIntroScene), Tolan brings Isran word of the Vigilants' fall, and Isran
  // comes to the player ("So who are you? What do you want?"). "What can I do to help?" (150):
  // Tolan tells of Dimhollow Crypt, and Isran sends the player there (DLC1VQ01 10).
  it('has Isran take the player on and send them to Dimhollow Crypt (DLC1VQ01 10)', async () => {
    if (!toldOfFort) return;
    const sim = await loadSim(toldOfFort);
    try {
      await sim.fastTravel(FORT_MARKER);
      await sim.step(2);
      const door = await sim.position(FORT_DOOR);
      expect(door && (await sim.walkPath(door, 240, 200))).toBe(true);
      expect(sim.activate(FORT_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(3);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(FORT_HALL);
      expect(sim.stageDone(DAWNGUARD, 100)).toBe(true);
      const isran = alias(sim, DAWNGUARD, ISRAN);
      const at = await sim.position(isran);
      expect(at && (await sim.walkPath(at, 120, 200))).toBe(true);
      // The scene plays out before Isran's ForceGreet (its phase 10).
      let topics = await sim.listen(isran, 300);
      expect(topics).toContain('I heard you were looking for vampire hunters.');
      topics = await sim.choose(/looking for vampire hunters/);
      expect(topics).toContain('What can I do to help?');
      expect(await sim.choose(/What can I do to help/)).toEqual([]);
      sim.goodbye();
      expect(sim.stageDone(DAWNGUARD, 150)).toBe(true);
      expect(await sim.until(() => sim.stageDone(VQ01, 10), 240)).toBe(true);
      const crossbow = await sim.formId('WEAP', 'DLC1CrossBow');
      // Isran hands the player a crossbow and bolts (the scene's phase 4: 190), the misc objective
      // done (180).
      expect(await sim.until(() => sim.stageDone(DAWNGUARD, 190), 120)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(DAWNGUARD, 180)).toBe(true);
      expect(await sim.runtime.itemCount(PLAYER_REF, crossbow)).toBe(1);
      expect(
        await sim.runtime.itemCount(PLAYER_REF, await sim.formId('AMMO', 'DLC1BoltSteel')),
      ).toBe(45);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
