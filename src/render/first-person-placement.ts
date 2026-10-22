// Where the player's first-person skeleton stands (src/shell/first-person-body.ts): on the
// feet, facing the view, turned about its camera node by the view's pitch. Platform-independent.

import type { Vec3 } from './math.ts';

/**
 * The first-person skeleton's placement (column-major): turned to `yaw` about z (compass
 * heading: model y forward), scaled, on `feet`, then turned about its camera node (`camera`,
 * in the skeleton's space) by `pitch` around the view's right axis: the arms keep their place
 * in view as the camera looks up or down.
 */
export function firstPersonMatrix(
  out: Float32Array,
  feet: Vec3,
  yaw: number,
  scale: number,
  camera: Vec3,
  pitch: number,
): Float32Array {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  // The skeleton's axes in the world before the pitch: x right, y forward, z up.
  const right: Vec3 = [cos * scale, -sin * scale, 0];
  const forward: Vec3 = [sin * scale, cos * scale, 0];
  const up: Vec3 = [0, 0, scale];
  const axes = [right, forward, up];
  // The camera node in the world (the pivot).
  const pivot: Vec3 = [
    feet[0] + right[0] * camera[0] + forward[0] * camera[1],
    feet[1] + right[1] * camera[0] + forward[1] * camera[1],
    feet[2] + up[2] * camera[2],
  ];
  // Rodrigues' rotation about the right axis r = (cos, -sin, 0) by the pitch.
  const r: Vec3 = [cos, -sin, 0];
  const c = Math.cos(pitch);
  const s = Math.sin(pitch);
  const rotate = (v: Vec3): Vec3 => {
    const dot = r[0] * v[0] + r[1] * v[1] + r[2] * v[2];
    const cross: Vec3 = [
      r[1] * v[2] - r[2] * v[1],
      r[2] * v[0] - r[0] * v[2],
      r[0] * v[1] - r[1] * v[0],
    ];
    return [
      v[0] * c + cross[0] * s + r[0] * dot * (1 - c),
      v[1] * c + cross[1] * s + r[1] * dot * (1 - c),
      v[2] * c + cross[2] * s + r[2] * dot * (1 - c),
    ];
  };
  axes.forEach((axis, i) => {
    const turned = rotate(axis);
    out[i * 4] = turned[0];
    out[i * 4 + 1] = turned[1];
    out[i * 4 + 2] = turned[2];
    out[i * 4 + 3] = 0;
  });
  const fromPivot = rotate([feet[0] - pivot[0], feet[1] - pivot[1], feet[2] - pivot[2]]);
  out[12] = pivot[0] + fromPivot[0];
  out[13] = pivot[1] + fromPivot[1];
  out[14] = pivot[2] + fromPivot[2];
  out[15] = 1;
  return out;
}
