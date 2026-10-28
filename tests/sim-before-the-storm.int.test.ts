// Integration test: MQ102 "Before the Storm" on Hadvar's route, in the headless simulation. MQ101
// ends as the game ends it (stage 210: the player went into the keep with Hadvar; 800: out of
// the cave, which sets MQ102A 5 and starts MQ102); the player then keeps by Hadvar to Riverwood,
// follows him into Alvor's house, and talks to Alvor. The second segment starts from the save
// the first took. Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const MQ101 = 0x3372b;
const MQ102 = 0x4e50d;
/** MQ102A: Hadvar's route (the friend's part of MQ102). */
const MQ102A = 0x2bf9c;
/** HadvarRef and AlvorREF. */
const HADVAR = 0x2bfa2;
const ALVOR = 0x13482;
/** ChargenExitMarker, outside Helgen's cave (MQ102's property). */
const CHARGEN_EXIT = 0xd19aa;
/** MQ102HadvarAlvorScene (stage 35 starts it). */
const ALVOR_SCENE = 0x2bfac;
/** Alvor's MQ102A topic that sets stage 50. */
const SUPPLIES = 'Do you have any supplies I could take?';

/** The player keeps by an actor (within `reach`), as one following them does. */
async function keepBy(sim: Sim, actor: number, reach: number): Promise<void> {
  const near = await sim.distance(actor, PLAYER_REF);
  const at = await sim.position(actor);
  const me = await sim.position(PLAYER_REF);
  if (near !== undefined && near > reach && at && me) {
    const k = (reach * 0.6) / near;
    await sim.moveTo([at[0] + (me[0] - at[0]) * k, at[1] + (me[1] - at[1]) * k, at[2] + 30]);
  }
}

describe.skipIf(!hasGamedata())('MQ102 Before the Storm (Hadvar’s route)', () => {
  /** The game as the first segment left it, in Riverwood (MQ102A 35). */
  let inRiverwood: Uint8Array | undefined;

  it('leaves Helgen with Hadvar and walks with him to Riverwood (MQ102 15, 10; MQ102A 35)', async () => {
    const sim = await openSim({ opening: true });
    try {
      await sim.step(1);
      for (const playing of sim.runtime.scenes.snapshot()) sim.runtime.scenes.stop(playing.scene);
      // Into the keep with Hadvar (FactionPath 1), then out of the cave (stage 800's route
      // entry sets MQ102A 5, which starts MQ102). Not awaited: the fragments wait for frames.
      void sim.runtime.quests.setStage(MQ101, 210);
      await sim.step(1);
      for (const playing of sim.runtime.scenes.snapshot()) sim.runtime.scenes.stop(playing.scene);
      void sim.runtime.quests.setStage(MQ101, 800);
      expect(await sim.until(() => sim.stageDone(MQ102, 5), 30)).toBe(true);
      const exit = await sim.runtime.placement(CHARGEN_EXIT);
      expect(exit?.world).toBeDefined();
      if (exit?.world === undefined) return;
      await sim.world.openExterior(exit.world, {
        arrival: { position: exit.position, heading: exit.rotation[2] },
      });
      // Out of the cave the exit's trigger sets MQ102 15 (MQ102A 10: MQ102AHadvarToRiverwood);
      // its phases lead by Bleak Falls and the Guardian Stones, waiting for the player.
      for (let second = 0; second < 400 && !sim.stageDone(MQ102A, 35); second++) {
        await sim.step(1);
        await keepBy(sim, HADVAR, 400);
      }
      expect(sim.stageDone(MQ102, 15)).toBe(true);
      expect(sim.stageDone(MQ102, 10)).toBe(true);
      expect(sim.stageDone(MQ101, 1000)).toBe(true);
      expect(sim.stageDone(MQ102A, 35)).toBe(true);
      await sim.step(1);
      inRiverwood = await sim.save();
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Found 2026-10-28: stage 35 started MQ102HadvarAlvorScene, which waited for ever for Dorthe:
  // the Riverwood kids' play scene holds her in its first phase (no action) until she and
  // Frodnar meet. A scene now takes an actor whose other scene has nothing running on it.
  it('plays Hadvar and Alvor’s scene into the house; Alvor sends the player to Whiterun (MQ102 30)', async () => {
    expect(inRiverwood).toBeDefined();
    if (!inRiverwood) return;
    const sim = await loadSim(inRiverwood);
    try {
      let inside = false;
      for (let second = 0; second < 400 && !sim.stageDone(MQ102A, 47); second++) {
        await sim.step(1);
        // The player follows Hadvar to Alvor and through his door (and waits inside by it).
        const hadvar = await sim.runtime.placement(HADVAR);
        if (!inside && hadvar && hadvar.world === undefined && hadvar.cell !== undefined) {
          await sim.openInterior(hadvar.cell);
          inside = true;
        } else if (!inside) await keepBy(sim, HADVAR, 300);
      }
      expect(sim.stageDone(MQ102A, 45)).toBe(true);
      expect(sim.stageDone(MQ102A, 47)).toBe(true);
      expect(sim.runtime.scenes.isPlaying(ALVOR_SCENE)).toBe(true);
      // The player walks up to Alvor and talks to him: his quest topic sets MQ102A 50, and that
      // MQ102 30 (the Jarl's objective).
      const at = await sim.position(ALVOR);
      if (at) await sim.moveTo([at[0] + 90, at[1], at[2] + 10]);
      expect(await sim.talk(ALVOR)).toContain(SUPPLIES);
      await sim.choose(SUPPLIES);
      sim.goodbye();
      await sim.step(1);
      expect(sim.stageDone(MQ102A, 50)).toBe(true);
      expect(sim.stageDone(MQ102, 30)).toBe(true);
      expect(sim.runtime.state.quest(MQ102).objectives.get(30)?.displayed).toBe(true);
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Found 2026-10-28, still open: in phase 26 of MQ102HadvarAlvorScene Alvor runs
  // MQ102AlvorForceGreet (ForceGreet: to the player, then the conversation with its topic), but
  // never reaches the player standing by the door (-537, -231, 241 in his house; Alvor at -580,
  // -42): its travel ends false about once a second (not stuck, not replaced or stopped, the
  // space check holds), so the procedure only waits and asks again. Next: which of the movers'
  // ends gives that travel up (the walker's path search in src/shell/actor-movers.ts, or a start
  // off the navmesh). The case above has the player walk up to him instead.
  // Further on, not driven yet: Whiterun's gate guards (MQ102 75..100), Irileth and Balgruuf in
  // Dragonsreach (110, 150: MQ103 8), Farengar (MQ102 160, MQ103 10), then MQ103 in Bleak Falls
  // Barrow (the bandits, Arvel in the web, the pillar puzzles, the claw door, the Dragonstone),
  // and Ralof's route (MQ102B).
  it.todo('has Alvor force-greet the player in his house (phase 26), then Whiterun and MQ103');
});
