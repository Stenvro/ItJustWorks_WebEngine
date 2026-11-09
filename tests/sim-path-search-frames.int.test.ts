// Integration (headless simulation): an actor's path searched over frames (ActorMovers with
// searches paced as while frames are drawn: docs/ai.md, "Searches over frames"). Without frames
// the simulation's searches end at once, so this paces them with node budgets of its own
// (ActorMovers.searchPacing): a budget of 0 a frame holds a search under way for as long as the
// test needs.
//
// Korvanjund01: MQ103BanditDisabler [000A45EB] holds a collision box [000A45EA] across the hall
// north of the entrance (y -5038 to -4925) until the quest disables it. With the box gone, a way
// from the entrance deep into the barrow takes a search of several shares of nodes (as the
// soldiers' searches for Alduin on Helgen's tower do); a short way near the entrance, one.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { findPath, pathSearchStats } from '../src/ai/pathfinding.ts';
import type { ActorMovers } from '../src/shell/actor-movers.ts';
import { navmeshTriangle } from '../src/world/navmesh.ts';
import { hasGamedata, openSim, PLAYER_REF, SIM_STEP, type Sim } from './helpers/sim.ts';

type Vec3 = [number, number, number];

const KORVANJUND01 = 0x152a1;
const BANDIT_BOX = 0xa45ea;
const BANDIT_DISABLER = 0xa45eb;
/** The box's south and north faces. */
const BOX_SOUTH = -5038;
const BOX_NORTH = -4925;
/** One share of a search (PathSearch gives way every 128 nodes). */
const SHARE = 128;
/** A search under way is held: no nodes a frame for searches going on. */
const HOLD = { frame: 0, first: SHARE };
/** Searches go on, one share a frame. */
const SLOW = { frame: SHARE, first: SHARE };
/** Searches end at once. */
const FREE = { frame: 1e9, first: 1e9 };

describe.skipIf(!hasGamedata())('path searches over frames (headless simulation)', () => {
  let sim: Sim;
  let movers: ActorMovers;
  /** A point on the walkers' side of the box, a short way from where they are placed. */
  let near: Vec3;
  /** A point deep in the barrow past the box, a search of several shares away. */
  let far: Vec3;
  /** The walkers placed: each test's travels end after it, passed or not. */
  const placed: number[] = [];

  /** An NPC placed at the player (south of the box), held from her packages. */
  const walker = async (): Promise<number> => {
    const reference = await sim.place(await sim.formId('NPC_', 'Hulda'), PLAYER_REF);
    sim.world.stage.ai.hold(reference, true);
    placed.push(reference);
    movers.searchPacing = FREE;
    await sim.step(1);
    return reference;
  };
  const boxStands = async (stands: boolean): Promise<void> => {
    await sim.runtime.setEnabled(BANDIT_DISABLER, stands);
    await sim.world.settle();
    await sim.step(0.1);
    const active = sim.world.stage.obstacles.active.some((entry) => entry.reference === BANDIT_BOX);
    expect(active).toBe(stands);
  };
  const searching = (reference: number): boolean => movers.travelOf(reference)?.searching === true;
  const points = (reference: number): readonly (readonly number[])[] =>
    movers.travelOf(reference)?.points ?? [];
  const go = (
    reference: number,
    to: Vec3,
    options: Parameters<ActorMovers['travel']>[4] = {},
  ): { arrived: boolean | undefined } => {
    const result: { arrived: boolean | undefined } = { arrived: undefined };
    void movers.travel(reference, to, 'walk', 32, options).then((done) => {
      result.arrived = done;
    });
    return result;
  };
  const distance = (reference: number, to: Vec3): number => {
    const at = sim.actor(reference)?.position ?? [Infinity, Infinity, Infinity];
    return Math.hypot(at[0] - to[0], at[1] - to[1]);
  };

  beforeAll(async () => {
    sim = await openSim({ interior: KORVANJUND01 });
    movers = sim.world.stage.movers;
    await sim.step(1);
    const at = sim.actor(PLAYER_REF)?.position ?? (await sim.position(PLAYER_REF));
    if (!at) throw new Error('no player position');
    const from: Vec3 = [at[0], at[1], at[2]];
    const set = sim.world.navmeshes;
    // A point a short walk from the player, south of the box, reached by a complete path.
    const candidates: Vec3[] = [];
    for (const [dx, dy] of [
      [0, -250],
      [250, 0],
      [-250, 0],
      [180, -180],
      [-180, -180],
      [0, 250],
    ] as const) {
      const point = set.nearest?.([from[0] + dx, from[1] + dy, from[2]], 128);
      if (point && point[1] < BOX_SOUTH - 64) candidates.push([point[0], point[1], point[2]]);
    }
    const short = candidates.find((point) => {
      const path = findPath(set, from, point, { radius: 20 });
      return path?.complete === true && Math.hypot(point[0] - from[0], point[1] - from[1]) > 150;
    });
    if (!short) throw new Error('no point near the player to walk to');
    near = short;
    // With the box gone, the triangle centre north of it whose way from the player takes the
    // most nodes (of every 8th triangle).
    await boxStands(false);
    const on = set.locate(from);
    if (!on) throw new Error('the player is off the navmesh');
    let most = 0;
    pathSearchStats.trace = [];
    for (let triangle = 0; triangle < on.navmesh.triangles.length; triangle += 8) {
      const [a, b, c] = navmeshTriangle(on.navmesh, triangle);
      const centre: Vec3 = [
        (a[0] + b[0] + c[0]) / 3,
        (a[1] + b[1] + c[1]) / 3,
        (a[2] + b[2] + c[2]) / 3,
      ];
      if (centre[1] < BOX_NORTH) continue;
      const path = findPath(set, from, centre, {
        radius: 20,
        obstacles: sim.world.stage.obstacles.index,
      });
      const nodes = pathSearchStats.trace.at(-1)?.nodes ?? 0;
      if (path?.complete === true && nodes > most) {
        most = nodes;
        far = centre;
      }
    }
    pathSearchStats.trace = undefined;
    // Several shares: held over frames under every pacing below.
    expect(most).toBeGreaterThan(4 * SHARE);
  }, 600_000);
  afterEach(async () => {
    // Each test's walkers go: the next one's walk alone from the player.
    for (const reference of placed.splice(0)) {
      movers.stop(reference);
      await sim.runtime.setEnabled(reference, false);
    }
    await sim.world.settle();
    await sim.step(0.1);
  });
  afterAll(async () => {
    movers.searchPacing = undefined;
    await sim.close();
  });

  it('holds a long search over frames while a short one of another actor ends at once', async () => {
    await boxStands(false);
    const long = await walker();
    const short = await walker();
    movers.searchPacing = SLOW;
    // The long one goes on over frames, taking each frame's share first (it began first).
    go(long, far);
    await sim.step(SIM_STEP);
    expect(searching(long)).toBe(true);
    // The other's short way ends in the frame it began, though the long one took the frame's
    // nodes.
    go(short, near);
    await sim.step(SIM_STEP);
    expect(searching(long)).toBe(true);
    expect(searching(short)).toBe(false);
    expect(points(short).length).toBeGreaterThan(1);
    // The long one ends in turn, its path through the hall.
    expect(await sim.until(() => !searching(long), 10)).toBe(true);
    expect(points(long).at(-1)?.[1] ?? -Infinity).toBeGreaterThan(BOX_NORTH);
  }, 180_000);

  it('searches again once it ends when an obstacle came across its way meanwhile', async () => {
    await boxStands(false);
    const reference = await walker();
    movers.searchPacing = HOLD;
    go(reference, far);
    await sim.step(SIM_STEP * 3);
    expect(searching(reference)).toBe(true);
    // The box comes while the search (against the navmesh without it) is under way.
    await boxStands(true);
    expect(searching(reference)).toBe(true);
    // It ends with the way open as it began; the box across it, it searches again at once: the
    // first path it follows stops short of the box (looked at in the frame it has one, before the
    // actors standing by, whose avoid nodes would have it search again too, come into it).
    movers.searchPacing = FREE;
    expect(await sim.until(() => points(reference).length > 1, 2)).toBe(true);
    const way = points(reference);
    expect(way.length).toBeGreaterThan(1);
    expect(Math.max(...way.map((point) => point[1] ?? Infinity))).toBeLessThan(BOX_SOUTH);
  }, 180_000);

  it('follows a moving destination on once its search ends, arriving where it is now', async () => {
    await boxStands(false);
    const reference = await walker();
    movers.searchPacing = HOLD;
    let target: Vec3 = far;
    const travel = go(reference, far, {
      moving: { position: () => target, recalc: 100 },
    });
    await sim.step(SIM_STEP * 3);
    expect(searching(reference)).toBe(true);
    // The destination moves on while the search for its first place is under way.
    target = near;
    await sim.step(SIM_STEP * 3);
    movers.searchPacing = FREE;
    await sim.until(() => travel.arrived !== undefined, 20);
    // It arrives where the destination is now, not at the end of the path to where it was.
    expect(travel.arrived).toBe(true);
    expect(distance(reference, near)).toBeLessThan(64);
  }, 180_000);

  it('drops a search under way when its travel is replaced', async () => {
    await boxStands(false);
    const reference = await walker();
    movers.searchPacing = HOLD;
    const first = go(reference, far);
    await sim.step(SIM_STEP * 3);
    expect(searching(reference)).toBe(true);
    // Replaced, the held search goes; the new short way ends in its first frame.
    const second = go(reference, near);
    await sim.step(SIM_STEP);
    expect(first.arrived).toBe(false);
    expect(searching(reference)).toBe(false);
    await sim.until(() => second.arrived !== undefined, 20);
    expect(second.arrived, `at ${String(sim.actor(reference)?.position)}`).toBe(true);
    expect(distance(reference, near)).toBeLessThan(64);
  }, 180_000);
});
