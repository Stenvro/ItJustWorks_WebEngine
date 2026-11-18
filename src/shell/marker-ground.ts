// The ground under a furniture marker: where one placed in its furniture as its cell loaded
// (an instant enter, no floor it came from) leaves to (actor-furniture.ts leave), and where an
// enter of furniture on another floor than the user's begins (actor-furniture.ts enterFloor).

import { Layer } from '../physics/collision-layers.ts';
import type { PhysicsWorld } from '../physics/physics-world.ts';
import type { Vec3 } from '../render/math.ts';

/** How far below a furniture marker its ground is looked for (units). */
const MARKER_GROUND_REACH = 4096;
/**
 * The ground is looked for from this far above the marker's height (units). Markers stand on
 * their floor (Brand-Shei's market counter in Riften): looked for from just under the marker, a
 * floor that is a mesh, open from below, was missed, and the ground under it taken (the land some
 * 570 units down, where he got up to). High enough to start over a lean's floor-level marker, low
 * enough to start under the top of a table in front of a chair (an enter's start is looked for
 * from its marker's height). A furniture's own body over its marker (a bed's frame) is met above
 * the marker: no drop. TODO(M13): ours, inferred; the height the original looks from is not
 * observed (any start over the floor's top and under a table's top behaves the same).
 */
export const MARKER_GROUND_LIFT = 16;

/**
 * The height of the ground under a marker (the world's physics, actors left out), if any within
 * reach. `at` is at the marker's own height: the lift over it is added here.
 */
export function markerGround(physics: PhysicsWorld | undefined, at: Vec3): number | undefined {
  const hit = physics?.raycast(
    [at[0], at[1], at[2] + MARKER_GROUND_LIFT],
    [0, 0, -1],
    MARKER_GROUND_REACH + MARKER_GROUND_LIFT,
    Layer.charController,
  );
  return hit && hit.owner?.kind !== 'actor' ? hit.point[2] : undefined;
}

/**
 * The floor an enter begins on: the user's if the furniture is on its floor (within
 * `sameFloor` of the marker's height); on another floor, the ground there, looked for from the
 * marker's height (`ground` lifts the look over it, as markerGround does); else the marker's
 * height.
 */
export function enterFloor(
  userZ: number,
  at: readonly [number, number, number],
  sameFloor: number,
  ground: ((at: readonly [number, number, number]) => number | undefined) | undefined,
): number {
  if (Math.abs(userZ - at[2]) <= sameFloor) return userZ;
  return ground?.(at) ?? at[2];
}
