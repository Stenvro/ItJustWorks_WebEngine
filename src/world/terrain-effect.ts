// Where ObjectReference.PlayTerrainEffect puts its effect (docs/scripting.md, "References").
// Observed in the original: a terrain effect stands on the land, not on its reference's 3D: at
// the reference's x and y, at the land's height there, turned as the reference is, and hung
// under the land's own node and the cell's physics world (an actor's collision layer for its
// pieces). Each piece of its model is then set on the land's height at its own place, so the
// model follows the ground's shape. It takes nothing else of the ground: no texture and no
// material (its model shows as modelled). Where no land is loaded under the reference (an
// interior, a cell without land) the effect cannot be set up. Platform-independent.

import type { Vec3 } from '../render/math.ts';

/** Where a terrain effect stands: on the land, turned as its reference (z, radians). */
export interface TerrainEffectPlacement {
  readonly position: Vec3;
  readonly heading: number;
}

/**
 * The terrain effect's place for a reference at `at` turned by `heading` (z, radians), given
 * the land's height at a point (undefined: no land loaded there); undefined: it cannot be set
 * up.
 */
export function terrainEffectPlacement(
  at: Vec3,
  heading: number,
  landHeight: (x: number, y: number) => number | undefined,
): TerrainEffectPlacement | undefined {
  const ground = landHeight(at[0], at[1]);
  if (ground === undefined) return undefined;
  return { position: [at[0], at[1], ground], heading };
}
