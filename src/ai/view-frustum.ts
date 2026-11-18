// The camera's view frustum: what is on screen (the player's sight for OnGainLOS, observed in
// the original: a reference's bound against the frustum). Platform-independent.

type Vec3 = readonly [number, number, number];

/** The camera's frame is about this wide against its height. */
const SCREEN_ASPECT = 16 / 9;
/** A camera that does not say its field of view sees this far up and down (radians). */
const SCREEN_HALF_HEIGHT = (30 * Math.PI) / 180;

/**
 * Whether a sphere is within the camera's view frustum (any part of it): in front of the camera
 * and inside its four side planes (half its vertical field of view up and down, that times the
 * frame's aspect across). The camera does not roll: its right is level.
 */
export function inViewFrustum(
  eye: Vec3,
  forward: Vec3,
  halfHeight: number | undefined,
  center: Vec3,
  radius: number,
): boolean {
  const to: Vec3 = [center[0] - eye[0], center[1] - eye[1], center[2] - eye[2]];
  const level = Math.hypot(forward[0], forward[1]);
  const right: Vec3 = level > 1e-6 ? [forward[1] / level, -forward[0] / level, 0] : [1, 0, 0];
  const up: Vec3 = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ];
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const depth = dot(to, forward);
  if (depth < -radius) return false;
  const vertical = halfHeight ?? SCREEN_HALF_HEIGHT;
  const across = Math.atan(Math.tan(vertical) * SCREEN_ASPECT);
  const side = dot(to, right);
  const height = dot(to, up);
  // Each side plane's inward normal: the forward axis tipped by the half angle.
  const inside = (offset: number, half: number): boolean =>
    depth * Math.sin(half) - Math.abs(offset) * Math.cos(half) >= -radius;
  return inside(side, across) && inside(height, vertical);
}
