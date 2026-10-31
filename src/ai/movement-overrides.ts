// What scripts make an actor's movement controller do instead of its AI (docs/scripting.md,
// "Actors"): Actor.SetPlayerControls hands it the player's controls; KeepOffsetFromActor keeps
// it at an offset from another actor until ClearKeepOffsetFromActor. Observed in the
// original: the native turns the three offset angles from degrees to radians and hands the
// target, the offset, the angles and the two radii to the actor's movement controller, which
// then steers it instead of its package's travel. The offset is in the target's own frame (x to
// its right, y ahead, z up, turned by its heading) and the angle is added to its heading.
// Platform-independent.

import type { MoveRequest } from './locomotion.ts';

/** An offset kept from an actor (game units and radians; the native's degrees turned). */
export interface KeepOffset {
  readonly target: number;
  readonly offset: readonly [number, number, number];
  readonly angle: readonly [number, number, number];
  /** From this distance from its place on it goes at the planner's full speed. */
  readonly catchUpRadius: number;
  /** Within this of its place it stands (facing as the offset turns it). */
  readonly followRadius: number;
}

/** Where an actor is, for the offset: its position and heading (compass radians). */
export interface OffsetPose {
  readonly position: readonly [number, number, number];
  readonly heading: number;
}

/** The KeepOffsetFromActor arguments (degrees) as the offset kept. */
export function keepOffsetOf(
  target: number,
  offset: readonly [number, number, number],
  angleDegrees: readonly [number, number, number],
  catchUpRadius: number,
  followRadius: number,
): KeepOffset {
  const rad = Math.PI / 180;
  return {
    target,
    offset,
    angle: [angleDegrees[0] * rad, angleDegrees[1] * rad, angleDegrees[2] * rad],
    catchUpRadius,
    followRadius,
  };
}

/** The point an actor keeps: the offset turned by the target's heading, from where it stands. */
export function offsetPlace(keep: KeepOffset, target: OffsetPose): [number, number, number] {
  const [x, y, z] = keep.offset;
  const sin = Math.sin(target.heading);
  const cos = Math.cos(target.heading);
  // Compass heading: 0 faces +Y, π/2 faces +X; the target's right is (cos, -sin).
  return [
    target.position[0] + x * cos + y * sin,
    target.position[1] - x * sin + y * cos,
    target.position[2] + z,
  ];
}

/** The normalized speed (walk 1, run 2) the keep-offset planner asks for at its catch-up radius. */
export const KEEP_OFFSET_FULL_SPEED = 3;

/**
 * What the actor's movement does this step to keep the offset, as observed in the original's
 * keep-offset planner: it goes straight for its place (its distance in three dimensions) at
 * a speed on the engine's normalized scale that grows linearly from 0 at the follow radius
 * to 3 at the catch-up radius and stays there beyond it ((distance − follow) / (catch-up −
 * follow), clamped to 0..1, × 3); within the follow radius it stands. Moving or standing it
 * faces the target's heading turned by the offset's angle about z.
 */
export function keepOffsetRequest(
  keep: KeepOffset,
  self: OffsetPose,
  target: OffsetPose,
): MoveRequest {
  const place = offsetPlace(keep, target);
  const dx = place[0] - self.position[0];
  const dy = place[1] - self.position[1];
  const dz = place[2] - self.position[2];
  const distance = Math.hypot(dx, dy, dz);
  const face = target.heading + keep.angle[2];
  const span = keep.catchUpRadius - keep.followRadius;
  const share =
    span > 0
      ? Math.min(1, Math.max(0, (distance - keep.followRadius) / span))
      : distance > keep.followRadius
        ? 1
        : 0;
  if (share <= 0 || (dx === 0 && dy === 0)) return { gait: 'walk', face };
  const pace = share * KEEP_OFFSET_FULL_SPEED;
  return { direction: [dx, dy], gait: pace > 1 ? 'run' : 'walk', face, pace };
}

/** The player's controls: the way asked in the view's frame (x right, y forward) and running. */
export interface ControlsWish {
  readonly x: number;
  readonly y: number;
  readonly running: boolean;
}

/**
 * What an actor under the player's controls does this step: it goes the way the controls ask,
 * turned into the world by the camera's heading (compass radians), at their gait; with no
 * input it stands. TODO(M13): the player-controls agent's own handling of turning and the
 * camera (the actor faces the way it goes here).
 */
export function controlsRequest(wish: ControlsWish, cameraHeading: number): MoveRequest {
  const gait = wish.running ? 'run' : 'walk';
  if (wish.x === 0 && wish.y === 0) return { gait };
  const sin = Math.sin(cameraHeading);
  const cos = Math.cos(cameraHeading);
  return { direction: [wish.x * cos + wish.y * sin, -wish.x * sin + wish.y * cos], gait };
}
