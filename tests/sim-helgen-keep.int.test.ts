// Integration test: MQ101 in Helgen Keep on the headless simulation. Setting a stage runs every
// log entry whose conditions hold (docs/scripting.md): the keep's stages have one entry for both
// routes and one per FactionPath, and the route's entry starts its scene. Skipped without game
// data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, openSim } from './helpers/sim.ts';

const MQ101 = 0x3372b;
/** HelgenKeep01. */
const KEEP = 0x5de24;
/** MQ101KeepIntroSceneB (Ralof's route) and MQ101KeepIntroSceneA (Hadvar's). */
const INTRO_RALOF = 0x4e1e2;
/** MQ101's PlayerFriend alias (stage 250's route entry fills it). */
const PLAYER_FRIEND = 73;

describe.skipIf(!hasGamedata())('MQ101 in Helgen Keep', () => {
  it('starts the route’s keep scene as the player enters with Ralof (stage 220, then 250)', async () => {
    const sim = await openSim({ opening: true });
    try {
      await sim.step(1);
      for (const playing of sim.runtime.scenes.snapshot()) sim.runtime.scenes.stop(playing.scene);
      // As MQ101SetStage220 does when the player walks in with Ralof (not awaited: the
      // fragments of the stages it sets wait for frames).
      void sim.runtime.quests.setStage(MQ101, 220);
      await sim.step(0.5);
      await sim.openInterior(KEEP);
      // The town's scenes are over by the time the player reaches the keep (here they still
      // hold Ralof: the opening was skipped to this point).
      for (const playing of sim.runtime.scenes.snapshot()) {
        if (playing.scene !== INTRO_RALOF) sim.runtime.scenes.stop(playing.scene);
      }
      await sim.step(1);
      expect(sim.stageDone(MQ101, 250)).toBe(true);
      // Entry 2 (FactionPath 2) ran after entry 0 (both routes): Ralof's scene and friend.
      expect(sim.runtime.scenes.isPlaying(INTRO_RALOF)).toBe(true);
      const ralof = sim.runtime.state.quest(MQ101).aliases.get(12);
      expect(sim.runtime.state.quest(MQ101).aliases.get(PLAYER_FRIEND)).toBe(ralof);
    } finally {
      await sim.close();
    }
  }, 300_000);

  it.todo(
    'opens the keep’s inner gate by the Imperial soldier’s lever package (KeepIntroSceneB ' +
      'phases 20-25) once the player has looted Gunjar: the sim’s activation of a corpse ' +
      '(MQ101CorpseSons01) misses it, so stage 257 is not reached headless yet',
  );
  it.todo(
    'runs both routes through the torture room, the caves (spiders, bear) and out (stage 900)',
  );
});
