// Actors in an actor's way (docs/ai.md, "Paths"; src/ai/avoidance.ts, which
// src/shell/actor-movers.ts follows), in a headless simulation of Korvanjund01's entrance hall
// (the quest's collision box across it disabled). Two copies of Hulda (NordRace: the advanced
// avoidance) walk it; the first placed has the lower form id, so of the two on their way it is
// the one that avoids the other (avoidanceKey, observed in the original).
//
// - An avoid node goes on one standing within half the actor's width and the other's radius of
//   its way, and is taken away as that one sets off (observed in the original).
// - Held up past fMaxTimeBlockedByActors by one ranked above it in its way, its path fails
//   (observed in the original); one near but not in its way (the player behind it) does not hold
//   it up. Being held up is measured as ours: under 16 units a second with that one in its way
//   (TODO(M13)), so a walker made slow (a travel's speed multiplier) shows the rule.
// - Not short of its goal (one standing on it), its way is done instead (inferred, TODO(M13)).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPath } from '../../../src/ai/pathfinding.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

type Vec3 = [number, number, number];

const KORVANJUND01 = 0x152a1;
/** MQ103BanditDisabler [000A45EB]: its collision box across the hall goes with it. */
const BANDIT_DISABLER = 0xa45eb;
/** North of the box, on the navmesh. */
const BEYOND: Vec3 = [-273, -4800, 655];
/** A walker this slow (units a second) hardly moves: under the movers' 16. */
const SLOW = 10;

describe.skipIf(!hasGamedata())('actors in the way (headless simulation)', () => {
  let sim: Sim;
  let hulda = 0;
  let walker = 0;
  let start: Vec3 = [0, 0, 0];
  /** South of the start, behind a walker going north. */
  let behind: Vec3 = [0, 0, 0];

  const at = (reference: number): Vec3 => {
    const position = sim.actor(reference)?.position;
    return position ? [position[0], position[1], position[2]] : [NaN, NaN, NaN];
  };
  const flat = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
  /** An actor set standing at a place (its controller with it). */
  const setAt = (reference: number, place: Vec3): void => {
    const staged = sim.actor(reference);
    if (!staged) return;
    staged.position = [...place];
    sim.world.stage.movers.teleport(staged);
  };
  const travel = (
    reference: number,
    to: Vec3,
    slow = false,
  ): { readonly result: () => boolean | undefined } => {
    let result: boolean | undefined;
    void sim.world.stage.movers
      .travel(reference, to, 'walk', 32, slow ? { speedMult: (gait) => SLOW / gait } : {})
      .then((done) => {
        result = done;
      });
    return { result: () => result };
  };
  const blockedLines = (): number =>
    sim.world.terminal.lines.filter(
      (line) => line.tag === 'actor' && line.text.includes('is blocked by actors'),
    ).length;

  beforeAll(async () => {
    sim = await openSim({ interior: KORVANJUND01 });
    await sim.runtime.setEnabled(BANDIT_DISABLER, false);
    await sim.world.settle();
    hulda = await sim.formId('NPC_', 'Hulda');
    walker = await sim.place(hulda, PLAYER_REF);
    sim.world.stage.ai.hold(walker, true);
    await sim.step(1);
    start = at(walker);
    // The player south of it, out of its way north.
    const away = flat(start, BEYOND);
    behind = [
      start[0] + ((start[0] - BEYOND[0]) / away) * 120,
      start[1] + ((start[1] - BEYOND[1]) / away) * 120,
      start[2],
    ];
    await sim.moveTo(behind);
    await sim.step(0.5);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('lays a node on one standing within half its width and its radius of the way, dropped as it sets off', async () => {
    const movers = sim.world.stage.movers;
    const radius = movers.radius(walker) ?? 0;
    expect(radius).toBeGreaterThan(0);
    const path = findPath(sim.world.navmeshes, at(walker), BEYOND, {
      radius,
      obstacles: sim.world.stage.obstacles.index,
    });
    const points = path?.points ?? [];
    expect(points.length).toBeGreaterThan(1);
    // A third of the way along its first leg, off it to the left: farther than half its radius
    // and the other's radius (the node's reach when its radius was taken for its width), nearer
    // than its radius and the other's.
    const [a, b] = [points[0], points[1]];
    if (!a || !b) return;
    const leg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const blocker = await sim.place(hulda, PLAYER_REF);
    sim.world.stage.ai.hold(blocker, true);
    const other = movers.radius(blocker) ?? 0;
    const off = radius * 0.75 + other;
    const along = Math.min(leg / 3, 200);
    const side: Vec3 = [
      a[0] + ((b[0] - a[0]) / leg) * along - ((b[1] - a[1]) / leg) * off,
      a[1] + ((b[1] - a[1]) / leg) * along + ((b[0] - a[0]) / leg) * off,
      a[2],
    ];
    setAt(blocker, side);
    await sim.step(0.3);
    const going = travel(walker, BEYOND);
    const laid = await sim.until(
      () => movers.avoidNodesOf(walker).some((node) => node.of === blocker),
      10,
    );
    expect(laid).toBe(true);
    // It sets off (south, out of the way): the node is taken away and the way searched again.
    void movers.travel(blocker, behind, 'walk', 32);
    const dropped = await sim.until(
      () => !movers.avoidNodesOf(walker).some((node) => node.of === blocker),
      5,
    );
    expect(dropped).toBe(true);
    await sim.until(() => going.result() !== undefined, 30);
    expect(going.result()).toBe(true);
    await sim.runtime.setEnabled(blocker, false);
    await sim.world.settle();
  }, 180_000);

  it('fails its path, held up past fMaxTimeBlockedByActors by one ranked above it meeting it head-on', async () => {
    // The walker (lower form id) slow from beyond the box to the start, the other on its way the
    // other way: the other keeps its way, the walker is held up and its path fails.
    const other = await sim.place(hulda, PLAYER_REF);
    sim.world.stage.ai.hold(other, true);
    setAt(other, start);
    await sim.step(0.3);
    const before = blockedLines();
    const going = travel(walker, start, true);
    let fastest = 0;
    const meet = travel(other, BEYOND);
    await sim.until(() => {
      fastest = Math.max(fastest, sim.world.stage.movers.speed(walker));
      return going.result() !== undefined;
    }, 40);
    expect(going.result()).toBe(false);
    expect(blockedLines()).toBe(before + 1);
    // It never went faster than the slow walker it was made.
    expect(fastest).toBeLessThan(16);
    await sim.until(() => meet.result() !== undefined, 30);
    await sim.runtime.setEnabled(other, false);
    await sim.world.settle();
  }, 180_000);

  it('is not held up by the player standing behind it, slow as it goes', async () => {
    // The player close behind it (within its avoidance radius: they rank above it), out of its
    // way: it walks on, hardly faster than standing, and arrives.
    const here = at(walker);
    const away = flat(here, BEYOND);
    await sim.moveTo([
      here[0] - ((BEYOND[0] - here[0]) / away) * 80,
      here[1] - ((BEYOND[1] - here[1]) / away) * 80,
      here[2],
    ]);
    const before = blockedLines();
    const going = travel(walker, BEYOND, true);
    await sim.until(() => going.result() !== undefined, 90);
    expect(going.result()).toBe(true);
    expect(blockedLines()).toBe(before);
  }, 240_000);

  it('ends its way done, not failed, held up by one standing on its goal', async () => {
    await sim.moveTo(behind);
    const goal = start;
    const other = await sim.place(hulda, PLAYER_REF);
    sim.world.stage.ai.hold(other, true);
    setAt(other, goal);
    await sim.step(0.5);
    const before = blockedLines();
    const going = travel(walker, at(other));
    await sim.until(() => going.result() !== undefined, 40);
    expect(going.result()).toBe(true);
    expect(blockedLines()).toBe(before);
    // It did not come within its arrival radius: the one on the goal kept it off.
    expect(flat(at(walker), at(other))).toBeGreaterThan(32);
  }, 180_000);
});
