// Integration test: DLC1VQ01 "Awakening" on the headless simulation, played through as the player
// plays it, segment by segment (each one loads the save the one before it left). Skipped without
// game data.

import { describe, expect, it } from 'vitest';
import { ObjectHandle } from '../src/scripting/values.ts';
import {
  alias,
  BRAZIERS,
  COFFIN,
  CRYPT_02,
  DIMHOLLOW_MARKER,
  fendOff,
  hearSerana,
  SPIKE,
  throughCrypt01,
  toAdalvald,
  toDimhollow,
  VQ01,
  VQ01_SERANA,
  VQ01_TOLAN,
  VQ02,
  walkToFighting,
} from './helpers/sim-dawnguard.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF } from './helpers/sim.ts';

/** The braziers' controller (DLC1VQ01PuzzleControllerScriptTrigger). */
const CONTROLLER = 0x2009fc9;

/** The game with the player at Dimhollow's door, Isran's errand on (DLC1VQ01 10). */
let atCrypt: Uint8Array | undefined;
/** The game with the player in the crypt's second cell. */
let inCrypt02: Uint8Array | undefined;
/** The game with the coffin open (30). */
let coffinOpen: Uint8Array | undefined;

describe.skipIf(!hasGamedata())('DLC1VQ01 Awakening', () => {
  // DLC1VQ01's own start for a game that skips ahead: its stage 10 is Isran's errand (played in
  // sim-dawnguard), which puts Dimhollow Crypt on the map; to its door.
  it('sends the player to Dimhollow Crypt (10)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      expect(await toDimhollow(sim)).toBe(true);
      expect(sim.runtime.state.quest(VQ01).objectives.get(30)?.displayed).toBe(true);
      expect(sim.runtime.mapMarkerVisible(DIMHOLLOW_MARKER)).toBe(true);
      atCrypt = await sim.save('Awakening at the crypt');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Into the crypt: in its first hall the vampires have Tolan at bay (15) and fall; on through
  // the cell to the door of the second.
  it('has the vampires holding Tolan fall, and the way on found (15)', async () => {
    if (!atCrypt) return;
    const sim = await loadSim(atCrypt);
    try {
      expect(await throughCrypt01(sim)).toBe(true);
      expect(sim.stageDone(VQ01, 15)).toBe(true);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(CRYPT_02);
      expect(alias(sim, VQ01, VQ01_SERANA)).not.toBe(0);
      expect(alias(sim, VQ01, VQ01_TOLAN)).not.toBe(0);
      expect(sim.isRunning(VQ02)).toBe(false);
      inCrypt02 = await sim.save('Awakening crypt 02');
    } finally {
      await sim.close();
    }
  }, 900_000);

  // Down to the chamber where the vampires hold Adalvald: they kill him (18) and fall; the book
  // by him is taken. In the coffin's chamber the player's hand on the spike (19) sets the
  // braziers turning (the controller's Solution), and each is pushed to its place in turn: the
  // coffin's activator, a volume without a model, opens the coffin (20, 30).
  it('has the player solve the braziers and open the coffin (18, 19, 20, 30)', async () => {
    if (!inCrypt02) return;
    const sim = await loadSim(inCrypt02);
    try {
      expect(await toAdalvald(sim)).toBe(true);
      expect(sim.stageDone(VQ01, 18)).toBe(true);
      expect(await walkToFighting(sim, SPIKE, 300, 150)).toBe(true);
      expect(sim.activate(SPIKE)).toBe(true);
      await sim.step(8);
      await fendOff(sim);
      expect(sim.stageDone(VQ01, 19)).toBe(true);
      const state = (reference: number, script: string): Promise<string> =>
        sim.runtime.vm.stateOf(new ObjectHandle(reference, script));
      expect(await state(CONTROLLER, 'DLC1VQ01PuzzleControllerScript')).toBe('solution');
      for (const [brazier, stand] of BRAZIERS) {
        expect(await walkToFighting(sim, stand, 60, 60)).toBe(true);
        expect(sim.activate(brazier)).toBe(true);
        await sim.step(6);
      }
      const states = await Promise.all(
        BRAZIERS.map(([brazier]) => state(brazier, 'DLC1VQ01PuzzleBrazierScript')),
      );
      expect(states).toEqual(['outer', 'inner', 'inner', 'outer', 'inner']);
      expect(await state(CONTROLLER, 'DLC1VQ01PuzzleControllerScript')).toBe('done');
      await sim.step(10);
      expect(await walkToFighting(sim, COFFIN, 60, 150)).toBe(true);
      expect(sim.activate(COFFIN)).toBe(true);
      expect(await sim.until(() => sim.stageDone(VQ01, 30), 30)).toBe(true);
      expect(sim.stageDone(VQ01, 20)).toBe(true);
      coffinOpen = await sim.save('Awakening 30');
    } finally {
      await sim.close();
    }
  }, 900_000);

  // Serana speaks to the player as she steps out ("Who were you expecting?"), and asks for their
  // help home ("Where do you need to go?"): Awakening is done (200) and Bloodline begins (5).
  it('has Serana ask the player to take her home (200)', async () => {
    if (!coffinOpen) return;
    const sim = await loadSim(coffinOpen);
    try {
      expect(await hearSerana(sim)).toBe(true);
      expect(sim.runtime.state.quest(VQ01).objectives.get(40)?.completed).toBe(true);
      expect(sim.isRunning(VQ01)).toBe(false);
      expect(sim.stageDone(VQ02, 5)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
