// Integration test: MQ101 in Helgen Keep on the headless simulation. Setting a stage runs every
// log entry whose conditions hold (docs/scripting.md): the keep's stages have one entry for both
// routes and one per FactionPath, and the route's entry starts its scene. Skipped without game
// data.

import { describe, expect, it } from 'vitest';
import { ObjectHandle } from '../src/scripting/values.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const MQ101 = 0x3372b;
/** HelgenKeep01. */
const KEEP = 0x5de24;
/** MQ101KeepIntroSceneB (Ralof's route) and MQ101KeepIntroSceneA (Hadvar's). */
const INTRO_RALOF = 0x4e1e2;
/** MQ101's PlayerFriend alias (stage 250's route entry fills it). */
const PLAYER_FRIEND = 73;
/** Gunjar's body (MQ101CorpseSons01), lying in the keep. */
const GUNJAR = 0xb1694;
/** MQ101KeepGate2Ref (the portcullis between Ralof and the Imperials) and its lever. */
const KEEP_GATE_2 = 0xb35af;
const KEEP_LEVER_2 = 0x47cc0;
/** MQ101's BarracksRoomSoldier01 (the officer, who carries the key) and BarracksRoomSoldier02. */
const BARRACKS_OFFICER = 173;
const BARRACKS_SOLDIER = 174;
/** MQ101KeepDoorKey. */
const KEEP_DOOR_KEY = 0xb5178;

/** The player keeps by Ralof (within the 100 units his "wait for the player" phases ask). */
async function keepBy(sim: Sim, ralof: number): Promise<void> {
  const near = await sim.distance(ralof, PLAYER_REF);
  const at = await sim.position(ralof);
  const me = await sim.position(PLAYER_REF);
  if (near !== undefined && near > 95 && at && me) {
    const k = 80 / near;
    await sim.moveTo([at[0] + (me[0] - at[0]) * k, at[1] + (me[1] - at[1]) * k, at[2] + 10]);
  }
}

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

  // Found 2026-10-24: the sim aimed its activation at a standing actor's chest, above a body
  // lying on the floor. It aims where the crosshair's rule meets an actor: its posed body.
  it('lets the player activate Gunjar’s corpse lying on the floor (stage 257)', async () => {
    const sim = await openSim({ opening: true });
    try {
      await sim.step(1);
      for (const playing of sim.runtime.scenes.snapshot()) sim.runtime.scenes.stop(playing.scene);
      void sim.runtime.quests.setStage(MQ101, 220);
      await sim.step(0.5);
      await sim.openInterior(KEEP);
      await sim.step(1);
      const gunjar = sim.actor(GUNJAR);
      expect(gunjar).toBeDefined();
      const [x, y, z] = gunjar?.position ?? [0, 0, 0];
      await sim.moveTo([x + 80, y, z + 10]);
      await sim.step(0.5);
      expect(sim.activate(GUNJAR)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(MQ101, 257)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 300_000);
  // Found 2026-10-28: the scene was never stuck in phase 6 (its line is 17 s long). Stage 275's
  // fragment has the Imperial activate the outer lever (KeepLever1.Activate(soldier)): that
  // default activation sat the player in the lever, walking them through the shut gate into
  // MQ101SetStage270RalofMarker, so stage 270 skipped the gate phases. Then the soldier, held in
  // a dialogue idle, never set out for the inner lever: an actor on its way to furniture was
  // taken for one in it, and its idle never stopped.
  it('opens the inner gate by the Imperial’s lever package (KeepIntroSceneB phases 20-26)', async () => {
    const sim = await openSim({ opening: true });
    try {
      await sim.step(1);
      for (const playing of sim.runtime.scenes.snapshot()) sim.runtime.scenes.stop(playing.scene);
      void sim.runtime.quests.setStage(MQ101, 220);
      await sim.step(0.5);
      await sim.openInterior(KEEP);
      for (const playing of sim.runtime.scenes.snapshot()) {
        if (playing.scene !== INTRO_RALOF) sim.runtime.scenes.stop(playing.scene);
      }
      const ralof = sim.runtime.state.quest(MQ101).aliases.get(12) ?? 0;
      const phase = (): number =>
        sim.runtime.scenes.snapshot().find((playing) => playing.scene === INTRO_RALOF)?.phase ?? -1;
      // The player keeps by Ralof (within the 100 units his "wait for the player" phase asks)
      // and loots Gunjar when he says to (stage 255).
      let looted = false;
      for (let second = 0; second < 150 && !sim.stageDone(MQ101, 270); second++) {
        await sim.step(1);
        const near = await sim.distance(ralof, PLAYER_REF);
        const at = await sim.position(ralof);
        const me = await sim.position(PLAYER_REF);
        if (near !== undefined && near > 95 && at && me) {
          const k = 80 / near;
          await sim.moveTo([at[0] + (me[0] - at[0]) * k, at[1] + (me[1] - at[1]) * k, at[2] + 10]);
        }
        if (!looted && sim.stageDone(MQ101, 255)) {
          const [x, y, z] = sim.actor(GUNJAR)?.position ?? [0, 0, 0];
          await sim.moveTo([x + 80, y, z + 10]);
          await sim.step(0.5);
          looted = sim.activate(GUNJAR);
        }
      }
      expect(looted).toBe(true);
      // The soldier pulled the inner lever, the gate opened (phase 25's condition), and the
      // fight's phase ended (its fragment sets 270), with the player never seated anywhere.
      expect(sim.scriptEvents({ event: 'OnActivate', target: KEEP_LEVER_2 }).length).toBe(1);
      expect(
        await sim.runtime.vm.getVariable(new ObjectHandle(KEEP_GATE_2, 'form'), '::isOpen_var'),
      ).toBe(true);
      expect(phase()).toBeGreaterThanOrEqual(26);
      expect(sim.stageDone(MQ101, 270)).toBe(true);
      expect(sim.world.stage.furniture.interaction(PLAYER_REF)).toBeUndefined();
    } finally {
      await sim.close();
    }
  }, 300_000);
  // Found 2026-10-28: with both Imperials killed (stage 280) the scene reached phase 30 ("Ralof
  // goes to get key": stage 260 or MQ101RalofGetDoorKey done) and stalled. That package is an
  // Acquire (Travel, then Find the MQ101KeepDoorKey within 101 units of the dead officer beside
  // a Wander, then Acquire): Find searched only placed references, and the key is carried, so
  // Ralof wandered by the body for ever. The engine's search looks into inventories too (a
  // corpse's among them), and Acquire takes the key from the body.
  it('has Ralof take the key from the dead officer and open the door (stages 285, 300)', async () => {
    const sim = await openSim({ opening: true });
    try {
      await sim.step(1);
      for (const playing of sim.runtime.scenes.snapshot()) sim.runtime.scenes.stop(playing.scene);
      void sim.runtime.quests.setStage(MQ101, 220);
      await sim.step(0.5);
      await sim.openInterior(KEEP);
      for (const playing of sim.runtime.scenes.snapshot()) {
        if (playing.scene !== INTRO_RALOF) sim.runtime.scenes.stop(playing.scene);
      }
      const quest = sim.runtime.state.quest(MQ101);
      const ralof = quest.aliases.get(12) ?? 0;
      let looted = false;
      for (let second = 0; second < 150 && !sim.stageDone(MQ101, 272); second++) {
        await sim.step(1);
        await keepBy(sim, ralof);
        if (!looted && sim.stageDone(MQ101, 255)) {
          const [x, y, z] = sim.actor(GUNJAR)?.position ?? [0, 0, 0];
          await sim.moveTo([x + 80, y, z + 10]);
          await sim.step(0.5);
          looted = sim.activate(GUNJAR);
        }
      }
      // The player fights the two Imperials (stage 280 once both are dead).
      const officer = quest.aliases.get(BARRACKS_OFFICER) ?? 0;
      await sim.kill(officer, PLAYER_REF);
      await sim.kill(quest.aliases.get(BARRACKS_SOLDIER) ?? 0, PLAYER_REF);
      expect(await sim.runtime.itemCount(officer, KEEP_DOOR_KEY)).toBe(1);
      for (let second = 0; second < 60 && !sim.stageDone(MQ101, 300); second++) {
        await sim.step(1);
        await keepBy(sim, ralof);
      }
      // Ralof took the key from the body (not the player: no stage 260) and opened the door.
      expect(sim.stageDone(MQ101, 260)).toBe(false);
      expect(await sim.runtime.itemCount(officer, KEEP_DOOR_KEY)).toBe(0);
      expect(await sim.runtime.itemCount(ralof, KEEP_DOOR_KEY)).toBe(1);
      expect(sim.stageDone(MQ101, 285)).toBe(true);
      expect(sim.stageDone(MQ101, 300)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 300_000);
  // Ralof's route, found 2026-10-28: past stage 305 (the player at MQ101SetStage305) the
  // storeroom scene (MQ101KeepScene2B) waits in phase 3 for Ralof's MQ101FriendToKeepMarker3,
  // and he stands still at (507, 4476, 384), at the head of the stairs down, for good. Not
  // looked into yet: why his travel to the marker does not go on (the way down, the collapsing
  // hall's trigger, the door at the foot). Hadvar's route (KeepIntroSceneA) is not driven yet.
  it.todo(
    'runs both routes through the torture room, the caves (spiders, bear) and out (stage 900)',
  );
});
