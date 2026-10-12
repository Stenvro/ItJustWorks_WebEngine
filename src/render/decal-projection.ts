// Where a placed decal lands. Vanilla decal references sit near, not on, the surface they
// mark (0–170 units away): the decal goes onto the first surface along its projection axis
// (the reference's +Y axis) within DECAL_REACH, and its box (its depth thick) is centred
// there. Platform-independent.
// Notes: docs/formats/esm.md ("Decals").

import type { CellDecal } from '../world/cell-loader.ts';
import type { Vec3 } from './math.ts';
import { raycastParts, type PlacedPart } from './raycast.ts';

/** How far a decal looks for its surface (vanilla references sit up to ~170 units away). */
export const DECAL_REACH = 512;
/** Steps of the ray march over the landscape. */
const TERRAIN_STEP = 16;

/** Distance along a ray to the landscape, if it crosses it within `maxDistance`. */
function raycastTerrain(
  height: (x: number, y: number) => number | undefined,
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
): number | undefined {
  let previous: number | undefined;
  for (let t = 0; t <= maxDistance + TERRAIN_STEP; t += TERRAIN_STEP) {
    const step = Math.min(t, maxDistance);
    const x = origin[0] + direction[0] * step;
    const y = origin[1] + direction[1] * step;
    const z = origin[2] + direction[2] * step;
    const ground = height(x, y);
    if (ground === undefined) {
      previous = undefined;
      continue;
    }
    const above = z - ground;
    if (previous !== undefined && Math.sign(above) !== Math.sign(previous)) {
      // Crossed the ground between the last step and this one.
      return step - TERRAIN_STEP * (Math.abs(above) / Math.abs(previous - above));
    }
    if (above === 0) return step;
    previous = above;
  }
  return undefined;
}

/**
 * Moves each decal's box onto the first surface along its projection axis: the placed parts
 * of the cell, and the landscape where `height` is given. Decals that find none stay centred
 * on their reference.
 */
export function projectDecals(
  decals: readonly CellDecal[],
  parts: readonly PlacedPart[],
  height?: (x: number, y: number) => number | undefined,
): CellDecal[] {
  return decals.map((decal) => {
    const box = decal.box;
    const axis: Vec3 = [box[4] ?? 0, box[5] ?? 0, box[6] ?? 0];
    const length = Math.hypot(axis[0], axis[1], axis[2]);
    if (length <= 0) return decal;
    const direction: Vec3 = [axis[0] / length, axis[1] / length, axis[2] / length];
    const origin: Vec3 = [box[12] ?? 0, box[13] ?? 0, box[14] ?? 0];
    const nearby = parts.filter(
      (p) =>
        Math.hypot(p.center[0] - origin[0], p.center[1] - origin[1], p.center[2] - origin[2]) <=
        p.radius + DECAL_REACH,
    );
    const hits = [
      raycastParts(nearby, origin, direction, DECAL_REACH),
      height && raycastTerrain(height, origin, direction, DECAL_REACH),
    ].filter((t): t is number => t !== undefined);
    if (hits.length === 0) return decal;
    const t = Math.min(...hits);
    const moved = box.slice();
    moved[12] = origin[0] + direction[0] * t;
    moved[13] = origin[1] + direction[1] * t;
    moved[14] = origin[2] + direction[2] * t;
    return { ...decal, box: moved };
  });
}
