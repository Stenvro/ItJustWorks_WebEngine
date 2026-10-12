// NiBillboardNode: turning a node to face the camera. Platform-independent.

import { maxScale, type Mat4, type Vec3 } from './math.ts';

/** BillboardMode: turn only about the node's up (Y) axis. */
const BILLBOARD_ROTATE_ABOUT_UP = new Set([1, 9]);
/**
 * BSROTATE_ABOUT_UP: the node stays upright in the world (its Z axis up, whatever its own
 * and its parents' rotation) and turns about Z so that its −Y side faces the camera: torch
 * and candle flames, glows and heat haze stay upright on tilted or carried objects.
 */
const BILLBOARD_BS_ROTATE_ABOUT_UP = 5;

/**
 * World matrix of a NiBillboardNode (`node`: its rest world) turned so that its Z axis points
 * at the camera; about its own Y axis only for the rotate-about-up modes, and upright about
 * the world's Z axis for BSROTATE_ABOUT_UP.
 */
export function billboardWorld(node: Mat4, mode: number, camera: Vec3): Mat4 {
  const position: Vec3 = [node[12] ?? 0, node[13] ?? 0, node[14] ?? 0];
  const scale = maxScale(node);
  const normalize = (v: Vec3): Vec3 => {
    const length = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / length, v[1] / length, v[2] / length];
  };
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const toCamera = normalize([
    camera[0] - position[0],
    camera[1] - position[1],
    camera[2] - position[2],
  ]);
  let x: Vec3;
  let y: Vec3;
  let z: Vec3;
  if (mode === BILLBOARD_BS_ROTATE_ABOUT_UP) {
    z = [0, 0, 1];
    const flat = Math.hypot(toCamera[0], toCamera[1]);
    y = flat > 1e-6 ? [-toCamera[0] / flat, -toCamera[1] / flat, 0] : [0, 1, 0];
    x = cross(y, z);
  } else if (BILLBOARD_ROTATE_ABOUT_UP.has(mode)) {
    y = normalize([node[4] ?? 0, node[5] ?? 0, node[6] ?? 1]);
    const along = toCamera[0] * y[0] + toCamera[1] * y[1] + toCamera[2] * y[2];
    z = normalize([
      toCamera[0] - y[0] * along,
      toCamera[1] - y[1] * along,
      toCamera[2] - y[2] * along,
    ]);
    x = cross(y, z);
  } else {
    z = toCamera;
    const up: Vec3 = Math.abs(z[2]) > 0.999 ? [0, 1, 0] : [0, 0, 1];
    x = normalize(cross(up, z));
    y = cross(z, x);
  }
  return new Float32Array([
    x[0] * scale,
    x[1] * scale,
    x[2] * scale,
    0,
    y[0] * scale,
    y[1] * scale,
    y[2] * scale,
    0,
    z[0] * scale,
    z[1] * scale,
    z[2] * scale,
    0,
    position[0],
    position[1],
    position[2],
    1,
  ]);
}
