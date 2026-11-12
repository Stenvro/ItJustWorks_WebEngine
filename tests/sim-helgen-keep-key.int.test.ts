// Integration test: after Helgen Keep's first fight on Ralof's route, Ralof fetches the key from
// the officer's body and opens the door (MQ101 280 to 300), wherever the body came to lie.
// KeepIntroSceneB's phase 30 runs MQ101RalofGetDoorKey (the Acquire template): a Travel to the
// officer (BarracksRoomSoldier01), a Find of the key within 101 units of him beside a Wander, the
// Acquire. Skipped without game data.
//
// Found 2026-11-12 in the browser: after the fight Ralof wandered about and MQ101 stood at 280
// for good. The Find's place was the body's own, where its ragdoll lay, but its search weighed
// the corpse at the spot the officer died on: a body that fell or was knocked more than 101 units
// from there was never found (docs/ai.md "Searches"; tests/conformance/ai/corpse-search.test.ts).
// Here the officer dies in the air, so his body comes to rest well away from where he died.
//
// The same browser run had MQ101 at 280 some 20 s before the officer died: the soldier took the
// player's blow twice in one instant, both killed him, and his OnDeath came twice.
// MQ101QuestScript.SetStageOnDeadCount counts the two Imperials' OnDeath calls up to
// stage280Target (2), so one death told twice was the fight over with the officer alive. An
// actor dies once (ActorEngine.kill; src/scripting/runtime/actor-engine.test.ts): the second
// case deals the soldier two lethal blows in one instant and has 280 wait for the officer.

import { describe, expect, it } from 'vitest';
import { ActorValue } from '../src/world/actor-values.ts';
import { DYING_TIMER } from '../src/world/dying.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const MQ101 = 0x3372b;
/** HelgenKeep01. */
const KEEP = 0x5de24;
/** MQ101KeepIntroSceneB (Ralof's route). */
const INTRO_RALOF = 0x4e1e2;
/** Gunjar's body (MQ101CorpseSons01). */
const GUNJAR = 0xb1694;
/** MQ101's Ralof alias, BarracksRoomSoldier01 (the officer) and BarracksRoomSoldier02. */
const RALOF = 12;
const BARRACKS_OFFICER = 173;
const BARRACKS_SOLDIER = 174;
/** MQ101RalofGetDoorKey's search radius round the officer. */
const KEY_RADIUS = 101;
/** How high above the floor the officer dies. */
const LIFT = 140;

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

/** The keep on Ralof's route up to the fight (MQ101 272): Ralof, the officer and the soldier. */
async function toTheFight(
  sim: Sim,
): Promise<{ readonly ralof: number; readonly officer: number; readonly soldier: number }> {
  await sim.step(1);
  for (const playing of sim.runtime.scenes.snapshot()) sim.runtime.scenes.stop(playing.scene);
  // As MQ101SetStage220 does when the player walks in with Ralof.
  void sim.runtime.quests.setStage(MQ101, 220);
  await sim.step(0.5);
  await sim.openInterior(KEEP);
  for (const playing of sim.runtime.scenes.snapshot()) {
    if (playing.scene !== INTRO_RALOF) sim.runtime.scenes.stop(playing.scene);
  }
  const quest = sim.runtime.state.quest(MQ101);
  const ralof = quest.aliases.get(RALOF) ?? 0;
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
  expect(sim.stageDone(MQ101, 272)).toBe(true);
  return {
    ralof,
    officer: quest.aliases.get(BARRACKS_OFFICER) ?? 0,
    soldier: quest.aliases.get(BARRACKS_SOLDIER) ?? 0,
  };
}

/** Ralof fetches the key from the officer's body (285) and opens the door (300). */
async function toTheDoor(sim: Sim, ralof: number): Promise<void> {
  for (let second = 0; second < 90 && !sim.stageDone(MQ101, 300); second++) {
    await sim.step(1);
    await keepBy(sim, ralof);
  }
  expect(sim.stageDone(MQ101, 285)).toBe(true);
  expect(sim.stageDone(MQ101, 300)).toBe(true);
}

describe.skipIf(!hasGamedata())('MQ101: the key on the officer’s body', () => {
  it('Ralof takes it from a body that lies far from where the officer died, and opens the door', async () => {
    const sim = await openSim({ opening: true });
    try {
      const { ralof, officer, soldier } = await toTheFight(sim);
      // The officer dies in the air: his body falls from there.
      const stood = await sim.position(officer);
      expect(stood).toBeDefined();
      if (!stood) return;
      sim.runtime.move(officer, [stood[0], stood[1], stood[2] + LIFT]);
      await sim.step(0.05);
      await sim.kill(officer, PLAYER_REF);
      await sim.kill(soldier, PLAYER_REF);
      await sim.step(3);
      const died = sim.actor(officer)?.position;
      const lies = sim.world.stage.livePlacement(officer)?.position;
      expect(died).toBeDefined();
      expect(lies).toBeDefined();
      if (!died || !lies) return;
      expect(Math.hypot(lies[0] - died[0], lies[1] - died[1], lies[2] - died[2])).toBeGreaterThan(
        KEY_RADIUS,
      );
      // MQ101EnemyScript's OnDeath comes as each one's dying ends: 280.
      await sim.until(() => sim.stageDone(MQ101, 280), DYING_TIMER);
      expect(sim.stageDone(MQ101, 280)).toBe(true);
      await toTheDoor(sim, ralof);
    } finally {
      await sim.close();
    }
  }, 900_000);

  it('the soldier dies once of two lethal blows in one instant: 280 waits for the officer, then Ralof fetches the key', async () => {
    const sim = await openSim({ opening: true });
    try {
      const { ralof, officer, soldier } = await toTheFight(sim);
      // The player cannot die here (immortal mode): the case is not about their fight.
      sim.runtime.debug.immortal = true;
      // Two lethal blows on the soldier, neither waiting for the other (the player's and
      // Ralof's on one frame).
      const actors = sim.runtime.actors;
      await Promise.all([
        actors.damage(soldier, ActorValue.health, 500, PLAYER_REF),
        actors.damage(soldier, ActorValue.health, 500, ralof),
      ]);
      // His dying over, his OnDeath told: once, and the officer lives, so no 280 yet.
      for (let second = 0; second < DYING_TIMER + 3; second++) {
        await sim.step(1);
        await keepBy(sim, ralof);
      }
      expect(await actors.isDead(soldier)).toBe(true);
      // (Both are told where one fails: the death counted twice is what sets 280 early.)
      expect
        .soft(sim.deaths().filter((death) => death.actor === soldier && death.dead))
        .toHaveLength(1);
      if (!(await actors.isDead(officer))) expect.soft(sim.stageDone(MQ101, 280)).toBe(false);
      // The officer dies (Ralof's doing, else a blow of the player's): 280, the key, the door.
      for (let second = 0; second < 20 && !(await actors.isDead(officer)); second++) {
        await sim.step(1);
        await keepBy(sim, ralof);
      }
      if (!(await actors.isDead(officer))) {
        expect(sim.stageDone(MQ101, 280)).toBe(false);
        await actors.damage(officer, ActorValue.health, 500, PLAYER_REF);
      }
      await sim.until(() => sim.stageDone(MQ101, 280), DYING_TIMER + 3);
      expect(sim.stageDone(MQ101, 280)).toBe(true);
      await toTheDoor(sim, ralof);
    } finally {
      await sim.close();
    }
  }, 900_000);
});
