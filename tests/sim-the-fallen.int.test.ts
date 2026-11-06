// Integration test: MQ301 "The Fallen" on the headless simulation, played through as the player plays
// it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

type Vec3 = [number, number, number];

const MQ206 = 0x36193;
const MQ301 = 0x44c56;
const MQ302 = 0x45923;
/** MQ301's aliases. */
const PAARTHURNAX = 0;
const JARL = 2;
/** The spot on the summit (as in sim-throat-of-the-world), and WhiterunDragonsreach. */
const ON_THE_SUMMIT: Vec3 = [56147, -48664, 36258];
const DRAGONSREACH = 0x165a3;

/** The game with the player sent to the Jarl of Whiterun (stage 25). */
let toTheJarl: Uint8Array | undefined;

/** A quest alias's reference. */
function alias(sim: Sim, quest: number, id: number): number {
  return sim.runtime.state.quest(quest).aliases.get(id) ?? 0;
}

/** An objective of MQ301 as the journal shows it. */
function objective(sim: Sim, id: number): { displayed: boolean; completed: boolean } {
  const state = sim.runtime.state.quest(MQ301).objectives.get(id);
  return { displayed: state?.displayed ?? false, completed: state?.completed ?? false };
}

describe.skipIf(!hasGamedata())('MQ301 The Fallen', () => {
  // MQ301's own start for a game that skips ahead: its stage 0 sets 1, which plays MQ206 to 240
  // (played in sim-alduins-bane), whose 220 is MQ301's 10. "I need to find out where Alduin went."
  // to Paarthurnax on the summit is 20, the objective to go to the Jarl (25).
  it('has Paarthurnax tell of a dragon to trap (0-25)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      void sim.runtime.quests.setStage(MQ301, 0);
      expect(await sim.until(() => sim.stageDone(MQ301, 10), 180)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(MQ206, 220)).toBe(true);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: false });
      await sim.moveTo(ON_THE_SUMMIT);
      await sim.step(1);
      const paarthurnax = alias(sim, MQ301, PAARTHURNAX);
      expect(await sim.enabled(paarthurnax)).toBe(true);
      const at = await sim.position(paarthurnax);
      expect(at && (await sim.walkPath(at, 60, 600))).toBe(true);
      expect(await sim.talk(paarthurnax)).toEqual(['I defeated Alduin, but he escaped.']);
      expect(await sim.choose(/I defeated Alduin/)).toContain(
        'I need to find out where Alduin went.',
      );
      await sim.choose(/where Alduin went/);
      expect(sim.stageDone(MQ301, 20)).toBe(true);
      sim.goodbye();
      await sim.step(1);
      expect(sim.stageDone(MQ301, 25)).toBe(true);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 20)).toEqual({ displayed: true, completed: false });
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      toTheJarl = await sim.save('MQ301 25');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // The Jarl (in Dragonsreach; the way there is sim-dragon-rising's): "I need to trap a dragon in
  // your palace" is 27; he will not while the war is on: "What if you didn't have to worry about an
  // enemy attack?" is 30, and MQ302 begins.
  it('has the Jarl refuse while the war is on (27-30)', async () => {
    if (!toTheJarl) return;
    const sim = await loadSim(toTheJarl);
    try {
      await sim.openInterior(DRAGONSREACH);
      await sim.step(2);
      const jarl = alias(sim, MQ301, JARL);
      const at = await sim.position(jarl);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      const first = await sim.talk(jarl);
      expect(first).toContain('I need your help. I need to trap a dragon in your palace.');
      await sim.choose(/trap a dragon in your palace/);
      expect(sim.stageDone(MQ301, 27)).toBe(true);
      await sim.choose(/You heard right/);
      await sim.choose(/The threat is worse/);
      await sim.choose(/only hopeless if we give up/);
      await sim.choose(/only way to find Alduin/);
      await sim.choose(/worry about an enemy attack/);
      expect(sim.stageDone(MQ301, 30)).toBe(true);
      sim.goodbye();
      await sim.step(1);
      expect(objective(sim, 25)).toEqual({ displayed: true, completed: false });
      expect(sim.stage(MQ302)).toBe(10);
      expect(sim.isRunning(MQ302)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
