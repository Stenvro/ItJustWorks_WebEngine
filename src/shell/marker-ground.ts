// The ground under a furniture marker: where one placed in its furniture as its cell loaded
// (an instant enter, no floor it came from) leaves to (actor-furniture.ts leave).

import { Layer } from '../physics/collision-layers.ts';
import type { PhysicsWorld } from '../physics/physics-world.ts';
import type { Vec3 } from '../render/math.ts';

/** How far below a furniture marker its ground is looked for (units). */
const MARKER_GROUND_REACH = 4096;
/**
 * The ground is looked for from this far above the marker (units). Markers stand on their floor
 * (Brand-Shei's market counter in Riften): looked for from just under the marker, a floor that
 * is a mesh, open from below, was missed, and the ground under it taken (the land some 570
 * units down, where he got up to). A furniture's own body over its marker (a bed's frame) is
 * met above the marker: no drop.
 */
const MARKER_GROUND_LIFT = 16;

/**
 * The height of the ground under a marker (the world's physics, actors left out), if any within
 * reach.
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
