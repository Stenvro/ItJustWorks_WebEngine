// What the quest-line simulations share (tests/sim-*.int.test.ts of the College of Winterhold):
// the player's ways of going after an actor, through the doors it takes, and of getting through
// a fight that is not what the case tests.

import { parseTeleport } from '../../src/world/cell-records.ts';
import { ActorValue } from '../../src/world/actor-values.ts';
import { PLAYER_REF, SIM_STEP, type Sim } from './sim.ts';

export type Vec3 = [number, number, number];

/** A quest alias's reference (0 if unfilled). */
export function alias(sim: Sim, quest: number, id: number): number {
  return sim.runtime.state.quest(quest).aliases.get(id) ?? 0;
}

/** An objective of a quest as the journal shows it. */
export function objective(
  sim: Sim,
  quest: number,
  id: number,
): { displayed: boolean; completed: boolean } {
  const state = sim.runtime.state.quest(quest).objectives.get(id);
  return { displayed: state?.displayed ?? false, completed: state?.completed ?? false };
}

/** The place of a reference: its interior cell, else its worldspace. */
async function placeOf(sim: Sim, reference: number): Promise<number | undefined> {
  const at = await sim.runtime.placement(reference);
  return at?.world ?? at?.cell;
}

/**
 * The load door of the loaded area that leads into a place (an interior cell or a worldspace),
 * the nearest to a point.
 */
export async function doorInto(
  sim: Sim,
  place: number,
  near: readonly [number, number, number],
): Promise<number | undefined> {
  let best: { door: number; distance: number } | undefined;
  for (const reference of sim.runtime.world.loadedReferences?.() ?? []) {
    const record = await sim.db.get(reference);
    if (record?.type !== 'REFR') continue;
    const teleport = parseTeleport(record);
    if (!teleport) continue;
    const cell = sim.db.cellOfReference(teleport.door);
    if (cell === undefined) continue;
    const there = sim.db.worldOfCell(cell) ?? cell;
    if (there !== place || !(await sim.enabled(reference))) continue;
    const at = await sim.position(reference);
    if (!at) continue;
    const distance = Math.hypot(at[0] - near[0], at[1] - near[1], at[2] - near[2]);
    if (!best || distance < best.distance) best = { door: reference, distance };
  }
  return best?.door;
}

/** The player goes through a load door: walks up to it and opens it. */
export async function goThrough(sim: Sim, door: number, seconds = 90): Promise<boolean> {
  const at = await sim.position(door);
  if (!at || !(await sim.walkPath(at, seconds, 150))) return false;
  if (!sim.activate(door)) return false;
  await sim.world.settle();
  await sim.step(1);
  return true;
}

/**
 * The player keeps after an actor until `done` (at most `seconds`): walks the way to it while
 * farther than `reach`, and through the door it went through when it leaves the place.
 */
export async function follow(
  sim: Sim,
  actor: number,
  done: () => boolean | Promise<boolean>,
  seconds: number,
  reach = 200,
): Promise<boolean> {
  const until = sim.time + seconds;
  let seen: readonly [number, number, number] | undefined;
  while (sim.time < until) {
    if (await done()) return true;
    const [mine, theirs] = await Promise.all([placeOf(sim, PLAYER_REF), placeOf(sim, actor)]);
    if (theirs !== undefined && mine !== theirs) {
      const door = await doorInto(sim, theirs, seen ?? sim.world.player.feet);
      if (door !== undefined && (await goThrough(sim, door, Math.max(5, until - sim.time)))) {
        continue;
      }
      await sim.step(1);
      continue;
    }
    const at = await sim.position(actor);
    if (at) seen = at;
    const [x, y] = sim.world.player.feet;
    if (at && Math.hypot(at[0] - x, at[1] - y) > reach) {
      const started = sim.time;
      await sim.walkPath(at, Math.min(2, until - sim.time), reach - 50);
      if (sim.time - started < SIM_STEP / 2) await sim.step(0.5);
    } else await sim.step(1);
  }
  return done();
}

/**
 * Those fighting the player fall to the player's blows (TODO(M13): the player's own blows, where
 * the fight is not what the segment tests).
 */
export async function fendOff(sim: Sim): Promise<number> {
  let fallen = 0;
  for (const staged of sim.actors()) {
    const actor = staged.reference;
    if (actor === PLAYER_REF || staged.dead) continue;
    if (sim.world.stage.combat.targetOf(actor) === PLAYER_REF) {
      await sim.kill(actor, PLAYER_REF);
      fallen += 1;
    }
  }
  return fallen;
}

/** Hurt, with none fighting them, the player waits an hour (the wait menu): their health comes back. */
export async function catchBreath(sim: Sim): Promise<void> {
  const health = await sim.runtime.actors.value(PLAYER_REF, ActorValue.health);
  if (health.current >= 60) return;
  const fighting = sim.actors().some((staged) => {
    return !staged.dead && sim.world.stage.combat.targetOf(staged.reference) === PLAYER_REF;
  });
  if (!fighting) await sim.rest(1, false);
}

/** The player makes their way to a point, what comes at them falling as they go (fendOff). */
export async function walkFighting(
  sim: Sim,
  target: readonly [number, number, number],
  seconds: number,
  reach = 200,
): Promise<boolean> {
  const until = sim.time + seconds;
  while (until - sim.time >= SIM_STEP / 2) {
    const started = sim.time;
    const there = await sim.walkPath(
      [target[0], target[1], target[2]],
      Math.min(5, until - sim.time),
      reach,
    );
    await fendOff(sim);
    await catchBreath(sim);
    if (there) return true;
    // A walk that found no way returns without a step: time goes on while it asks again.
    if (sim.time - started < SIM_STEP / 2) await sim.step(0.5);
  }
  return false;
}

/** The player walks up to an actor and talks to it; the topics listed (none: no conversation). */
export async function approachAndTalk(sim: Sim, actor: number, seconds = 90): Promise<string[]> {
  const at = await sim.position(actor);
  if (!at || !(await sim.walkPath(at, seconds, 150))) return [];
  let topics = await sim.talk(actor);
  for (let again = 0; again < 3 && topics?.length === 0; again++) {
    topics = await sim.listen(actor, 3);
  }
  return topics ?? [];
}
