// The first-person geometry's view (docs/rendering.md, "First person"): the engine draws the
// player's arms and what they hold through a camera of their own, with first person's field of
// view ([Display] fDefault1stPersonFOV, the console's second fov value) and a near plane of its
// own ([Display] fNear1stPersonDistance, 5 units), drawn into the nearest share of the depth
// range ([Display] f1stPersonFarDepthRange, 0.01), over the world (observed in the original).
// Its particle systems (a spell in the hand, a torch's flame) are drawn the same way. Here the arms are drawn with the world (common.wgsl) through this
// view-projection, their depth moved into the band nearest the eye that the world never reaches:
// the player stays farther than the world's near plane (fNearDistance) from any wall.

import { multiply, perspectiveReversedZ, type Mat4 } from './math.ts';

/** The first-person camera's near plane (game units): [Display] fNear1stPersonDistance. */
export const FIRST_PERSON_NEAR = 5;

/**
 * Where the first-person depth band starts (reversed Z; common.wgsl FIRST_PERSON_DEPTH): the
 * nearest [Display] f1stPersonFarDepthRange (0.01) of the depth range.
 */
export const FIRST_PERSON_DEPTH = 0.99;

/**
 * The vertical field of view (radians) of a horizontal one across a 4:3 frame (degrees), as
 * fDefaultWorldFOV and fDefault1stPersonFOV are (wider screens see more at the sides).
 */
export function verticalFov(degrees: number): number {
  return 2 * Math.atan(Math.tan((degrees * Math.PI) / 360) * 0.75);
}

/**
 * The first-person view-projection: `view` seen with first person's field of view (degrees)
 * and near plane ([Display] fNear1stPersonDistance).
 */
export function firstPersonViewProjection(
  view: Mat4,
  degrees: number,
  aspect: number,
  lensShift = 0,
  out: Mat4 = new Float32Array(16),
  near = FIRST_PERSON_NEAR,
): Mat4 {
  const projection = perspectiveReversedZ(verticalFov(degrees), aspect, near);
  projection[8] = -lensShift;
  return multiply(projection, view, out);
}

/**
 * The depth a first-person point is drawn at (reversed Z, 1 at the eye), from its depth through
 * the first-person projection: moved into [FIRST_PERSON_DEPTH, 1] (common.wgsl does it in clip
 * space, linear, so it interpolates across a triangle as the depth does).
 */
export function firstPersonDepth(depth: number): number {
  return FIRST_PERSON_DEPTH + (1 - FIRST_PERSON_DEPTH) * depth;
}
