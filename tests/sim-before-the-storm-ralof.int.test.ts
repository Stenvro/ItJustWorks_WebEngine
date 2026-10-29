// Integration test: MQ102 "Before the Storm" on Ralof's route (MQ102B), in the headless
// simulation. MQ101 ends as the game ends it (stage 220: the player went into the keep with
// Ralof; 800: out of the cave, which sets MQ102B 5 and starts MQ102); the player then keeps by
// Ralof to Riverwood, where he meets his sister Gerdur at the mill (MQ102RalofGerdurScene).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const MQ101 = 0x3372b;
const MQ102 = 0x4e50d;
/** MQ102B: Ralof's route (the friend's part of MQ102). */
const MQ102B = 0x2610a;
/** RalofRef. */
const RALOF = 0x2bf9e;
/** ChargenExitMarker, outside Helgen's cave (MQ102's property). */
const CHARGEN_EXIT = 0xd19aa;

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

/** The player fights back: whoever is in combat with them dies by their hand. */
async function defend(sim: Sim): Promise<void> {
  const fighting = new Map<number, boolean>();
  for (const event of sim.events('combat')) {
    if (event.target === PLAYER_REF) fighting.set(event.actor, event.state !== 0);
    else fighting.delete(event.actor);
  }
  for (const [actor, now] of fighting) {
    if (now && !(await sim.runtime.actors.isDead(actor))) await sim.kill(actor, PLAYER_REF);
  }
}

describe.skipIf(!hasGamedata())('MQ102 Before the Storm (Ralof’s route)', () => {
  it('leaves Helgen with Ralof and walks with him to Riverwood (MQ102 15, 10; MQ102B 35)', async () => {
    const sim = await openSim({ opening: true });
    try {
      await sim.step(1);
      for (const playing of sim.runtime.scenes.snapshot()) sim.runtime.scenes.stop(playing.scene);
      // Into the keep with Ralof (FactionPath 2), then out of the cave (stage 800's route
      // entry sets MQ102B 5, which starts MQ102). Not awaited: the fragments wait for frames.
      void sim.runtime.quests.setStage(MQ101, 220);
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
      for (let second = 0; second < 400 && !sim.stageDone(MQ102B, 35); second++) {
        await sim.step(1);
        await keepBy(sim, RALOF, 400);
        await defend(sim);
      }
      expect(sim.stageDone(MQ102, 15)).toBe(true);
      expect(sim.stageDone(MQ102, 10)).toBe(true);
      expect(sim.stageDone(MQ101, 1000)).toBe(true);
      expect(sim.stageDone(MQ102B, 35)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 900_000);

  // Not driven yet (2026-10-29): from Riverwood on, MQ102RalofGerdurScene (Ralof to Gerdur at
  // the mill, Hod and Frodnar to the clearing), Gerdur's topic (MQ102B 50, MQ102 30), and on
  // to Whiterun as Hadvar's route does (tests/sim-before-the-storm.int.test.ts). Seen once:
  // the player keeping by Ralof for 600 s reached MQ102B 52 (MQ102 22) without 50, Ralof on
  // package 0x5799a heading south-east of Riverwood; not looked into.
  it.todo(
    'plays Ralof and Gerdur’s scene at the mill; Gerdur sends the player to Whiterun (MQ102B 50; MQ102 30)',
  );
});
