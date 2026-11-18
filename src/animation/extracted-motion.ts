// The motion a graph's clips extract from their root (their root motion) as the engine hands it
// to the character controller. Observed in the original ([Animation]
// bApplyPitchToExtractedMotion, built-in default 1): an actor whose character controller is
// pitched has the translation of its extracted motion turned by that pitch about its own x axis
// (right): the forward motion of a clip climbs or falls with the controller, so on a slope only
// the cosine of the pitch of it is ground speed. A pitch within float epsilon of 0 leaves it as
// it is; the motion's turn (its yaw) is not touched. The controller's pitch is the orientation
// controller's lean with the ground (src/world/actor-ground.ts: a quadruped's tilt).
// Platform-independent.

/** The smallest pitch the engine turns the motion by (radians: float epsilon). */
export const PITCH_EPSILON = 1.1920929e-7;

/**
 * The extracted motion's translation (x right, y forward, z up, in the actor's frame) turned by
 * its controller's pitch (radians, nose up positive, as Tilt.pitch): forward motion goes up the
 * slope the actor leans up, and down the one it leans down.
 */
export function pitchedMotion(
  translation: readonly [number, number, number],
  pitch: number,
): [number, number, number] {
  const [x, y, z] = translation;
  if (!(Math.abs(pitch) >= PITCH_EPSILON)) return [x, y, z];
  const sin = Math.sin(pitch);
  const cos = Math.cos(pitch);
  return [x, y * cos - z * sin, z * cos + y * sin];
}
