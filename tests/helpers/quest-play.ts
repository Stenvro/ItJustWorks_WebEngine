// What the quest-line simulations share (tests/sim-*.int.test.ts of the College of Winterhold):
// the player's ways of going after an actor, through the doors it takes, and of getting through
// a fight that is not what the case tests.

import type { Space } from '../../src/ai/package-start.ts';
import { loadRouteMap } from '../../src/ai/route-map.ts';
import { findRoute, type RouteEnd, type RouteMap } from '../../src/ai/routes.ts';
import { ObjectHandle } from '../../src/scripting/values.ts';
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

/** The load doors' routes of the load order, read once per file (src/ai/routes.ts). */
let routeMap: Promise<RouteMap> | undefined;

/**
 * The player makes their way to where a reference is now, as one who knows the way: the load
 * doors of the route there (src/ai/routes.ts, as actors find theirs) gone through in turn, what
 * fights them falling, then up to it within `reach`. Whether they got there.
 */
export async function travelTo(
  sim: Sim,
  target: number,
  seconds: number,
  reach = 150,
): Promise<boolean> {
  const until = sim.time + seconds;
  routeMap ??= loadRouteMap(sim.db);
  const map = await routeMap;
  const endOf = async (reference: number): Promise<RouteEnd | undefined> => {
    const at = await sim.runtime.placement(reference);
    if (!at) return undefined;
    const space: Space =
      at.world !== undefined
        ? { kind: 'world', world: at.world }
        : { kind: 'interior', cell: at.cell ?? 0 };
    const navmesh = map.nearestNavmesh(space, at.position);
    return navmesh === undefined ? undefined : { space, position: at.position, navmesh };
  };
  // The way as planned from the start, its doors in turn (planned again from an arrival, a place's
  // other doors may look nearer than the stair to the next: the College's tower doors).
  const [from, to] = await Promise.all([endOf(PLAYER_REF), endOf(target)]);
  if (!from || !to) return false;
  for (const { door } of findRoute(map, from, to)?.doors ?? []) {
    const at = await sim.position(door);
    if (!at || !(await walkFighting(sim, at, until - sim.time, 150))) return false;
    if (!sim.activate(door)) return false;
    await sim.world.settle();
    await sim.step(1);
  }
  const at = await sim.position(target);
  return at !== undefined && walkFighting(sim, at, Math.max(1, until - sim.time), reach);
}

/**
 * The player solves a Nordic pillar puzzle as one who has read its carved hints: each pillar
 * (defaultPuzzlePillarNoFurn) turned until it shows the face its hint names (its solveState), then
 * the lever pulled (defaultPillarPuzzleLeverNoFurn), which opens the way. Whether every pillar
 * came to its face.
 */
export async function solvePillars(
  sim: Sim,
  pillars: readonly number[],
  lever: number,
): Promise<boolean> {
  const vm = sim.runtime.vm;
  let solved = true;
  for (const pillar of pillars) {
    const handle = new ObjectHandle(pillar, 'defaultpuzzlepillarnofurn');
    const at = await sim.position(pillar);
    if (at) await walkFighting(sim, at, 60, 180);
    const solve = await vm.getVariable(handle, '::solveState_var');
    const want = `position0${typeof solve === 'number' ? String(solve) : '?'}`;
    for (let turn = 0; turn < 4 && (await vm.stateOf(handle)) !== want; turn++) {
      sim.activate(pillar);
      for (let wait = 0; wait < 10 && (await vm.stateOf(handle)) === 'busy'; wait++) {
        await sim.step(0.5);
      }
      await sim.step(0.5);
    }
    if ((await vm.stateOf(handle)) !== want) solved = false;
  }
  const at = await sim.position(lever);
  if (at) await walkFighting(sim, at, 60, 150);
  sim.activate(lever);
  await sim.step(4);
  return solved;
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
 * The player answers the conversation open now: the first listed topic each time that one of
 * `answers` matches, until none does (or it ends). The topics chosen.
 */
export async function converse(sim: Sim, answers: readonly RegExp[]): Promise<string[]> {
  const chosen: string[] = [];
  for (let turn = 0; turn < 12; turn++) {
    // A topic once asked is not asked again (its answer is known).
    const topic = sim.topics.find(
      (each) => !chosen.includes(each) && answers.some((answer) => answer.test(each)),
    );
    if (topic === undefined) break;
    chosen.push(topic);
    if ((await sim.choose(topic)).length === 0) break;
  }
  sim.goodbye();
  return chosen;
}

/**
 * The player keeps up with an actor who leads (follow), what fights them falling (fendOff), and
 * answers with `answers` whoever comes to talk (a force greet, a scene's), until `done`. The
 * topics chosen on the way.
 */
export async function keepUp(
  sim: Sim,
  actor: number,
  answers: readonly RegExp[],
  done: () => boolean | Promise<boolean>,
  seconds: number,
  reach = 200,
): Promise<string[]> {
  const until = sim.time + seconds;
  const chosen: string[] = [];
  while (sim.time < until && !(await done())) {
    await follow(sim, actor, done, Math.min(4, until - sim.time), reach);
    await fendOff(sim);
    await catchBreath(sim);
    const topics = await sim.listen(undefined, 0.5);
    if (topics !== undefined) chosen.push(...(await converse(sim, answers)));
  }
  return chosen;
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
