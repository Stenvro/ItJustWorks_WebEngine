// Integration test: CW03 "Message to Whiterun" (the Legion's) on the headless simulation, played
// as the player plays it. Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, openSim, type Sim } from './helpers/sim.ts';

/** CW, the civil war's own quest (CWScript). */
const CW = 0x19e53;
const CW01A = 0xd517a;
const CW02A = 0x2d75c;
const CW03 = 0xd661c;
const MQ104 = 0x2610c;
const CASTLE_DOUR = 0x213a0;
/** WhiterunWorld and Dragonsreach (WhiterunDragonsreach). */
const WHITERUN = 0x1a26f;
const DRAGONSREACH = 0x165a3;
/** CW03's Balgruuf alias, and the council's scene at the map table (CW03Scene). */
const BALGRUUF = 0;
const COUNCIL_SCENE = 0xda263;

/** A quest alias's reference. */
function alias(sim: Sim, quest: number, id: number): number {
  return sim.runtime.state.quest(quest).aliases.get(id) ?? 0;
}

describe.skipIf(!hasGamedata())('CW03 Message to Whiterun', () => {
  // The Legion's soldier (Joining the Legion's stages, as tests/sim-joining-the-legion.int.test.ts
  // plays them), Dragon Rising done (its 160 and 200: the Jarl's word on the dragon), the Jagged
  // Crown delivered (CW02A 200 sets CW03 10). In Dragonsreach: "I have an important message from
  // General Tullius." Balgruuf takes the letter (15); with the dragon dealt with he reads it
  // ("Hmm... these are interesting reports...": 20; without, 16 sends the player to help with
  // the dragons first), and his council meets at the map table (CW03Scene: 30, 40).
  it('has the player bring Tullius’s message to Balgruuf, whose council meets on it (CW03 10-40)', async () => {
    const sim = await openSim({ hour: 10, interior: CASTLE_DOUR });
    try {
      await sim.step(1);
      for (const stage of [1, 100, 150, 160, 200]) {
        void sim.runtime.quests.setStage(CW01A, stage);
        expect(await sim.until(() => sim.stageDone(CW01A, stage), 30)).toBe(true);
      }
      // The oath's fragment makes the player the Legion's (CW 11) as it runs on.
      expect(await sim.until(() => sim.stageDone(CW, 11), 30)).toBe(true);
      for (const stage of [160, 200]) {
        void sim.runtime.quests.setStage(MQ104, stage);
        expect(await sim.until(() => sim.stageDone(MQ104, stage), 30)).toBe(true);
      }
      void sim.runtime.quests.setStage(CW02A, 200);
      expect(await sim.until(() => sim.stageDone(CW03, 10), 30)).toBe(true);
      await sim.step(2);
      const deliver = (): boolean =>
        sim.runtime.state.quest(CW03).objectives.get(10)?.displayed === true;
      expect(await sim.until(deliver, 10)).toBe(true);
      await sim.world.openExterior(WHITERUN, {
        arrival: { position: [19567, -7233, -3540], heading: Math.PI / 4 },
      });
      await sim.step(1);
      await sim.openInterior(DRAGONSREACH);
      await sim.step(2);
      const balgruuf = alias(sim, CW03, BALGRUUF);
      const at = await sim.position(balgruuf);
      expect(at && (await sim.walkPath(at, 90, 150))).toBe(true);
      expect(await sim.talk(balgruuf)).toContain(
        'I have an important message from General Tullius.',
      );
      await sim.choose(/important message from General Tullius/);
      await sim.choose(/Ulfric plans to attack Whiterun/);
      expect(await sim.choose(/For the Jarl's eyes only/)).toEqual([]);
      sim.goodbye();
      expect(sim.stageDone(CW03, 15)).toBe(true);
      expect(sim.stageDone(CW03, 20)).toBe(true);
      expect(sim.stageDone(CW03, 16)).toBe(false);
      expect(await sim.until(() => sim.stageDone(CW03, 30), 120)).toBe(true);
      expect(sim.runtime.scenes.isPlaying(COUNCIL_SCENE)).toBe(true);
      expect(await sim.until(() => sim.stageDone(CW03, 40), 400)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 900_000);
});
