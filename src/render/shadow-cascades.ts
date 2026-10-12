// Cascaded shadow maps for the sun: the view frustum up to the shadow distance is cut into
// slices, each covered by an orthographic view from the light, snapped to whole shadow-map
// texels so shadows do not shimmer as the camera moves. Platform-independent.

import { project } from './frustum.ts';
import { lookAt, multiply, type Mat4, type Vec3 } from './math.ts';

export const SHADOW_CASCADES = 4;
/** Far end of each cascade (game units); fShadowDistance (Ultra) is 8000. */
export const SHADOW_SPLITS: readonly number[] = [700, 1800, 4000, 8000];
/** Casters this far towards the light from a slice still throw shadows into it. */
const CASTER_REACH = 20000;

export interface Cascade {
  readonly viewProj: Mat4;
  /** Distance from the camera where the cascade ends. */
  readonly far: number;
  /** World units per shadow-map texel. */
  readonly texelSize: number;
}

/** Orthographic projection to WebGPU's 0..1 depth (right-handed, looking down −Z). */
export function orthographic(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
): Mat4 {
  const m = new Float32Array(16);
  m[0] = 2 / (right - left);
  m[5] = 2 / (top - bottom);
  m[10] = -1 / (far - near);
  m[12] = -(right + left) / (right - left);
  m[13] = -(top + bottom) / (top - bottom);
  m[14] = -near / (far - near);
  m[15] = 1;
  return m;
}

/**
 * Fits the cascades. `inverseViewProj` is the camera's (reversed-Z, infinite) inverse
 * view-projection with near plane `near`; `toLight` points towards the sun.
 */
export function fitCascades(
  inverseViewProj: Mat4,
  near: number,
  toLight: Vec3,
  mapSize: number,
  splits: readonly number[] = SHADOW_SPLITS,
): Cascade[] {
  const up: Vec3 = Math.abs(toLight[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
  // Rotation only: the light looks along −toLight from the origin.
  const view = lookAt([0, 0, 0], [-toLight[0], -toLight[1], -toLight[2]], up);
  const cascades: Cascade[] = [];
  let start = near;
  for (const end of splits) {
    // Slice corners: NDC depth of a view distance d is near / d.
    const corners: Vec3[] = [];
    for (const d of [start, end]) {
      for (const [x, y] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const) {
        corners.push(project(inverseViewProj, [x, y, near / d]));
      }
    }
    const center: [number, number, number] = [0, 0, 0];
    for (const [x, y, z] of corners) {
      center[0] += x / 8;
      center[1] += y / 8;
      center[2] += z / 8;
    }
    let radius = 0;
    for (const c of corners) {
      radius = Math.max(radius, Math.hypot(c[0] - center[0], c[1] - center[1], c[2] - center[2]));
    }
    // A radius that changes only in steps keeps the texel size steady.
    radius = Math.ceil(radius / 16) * 16;
    const texelSize = (2 * radius) / mapSize;
    const [cx, cy, cz] = project(view, center);
    const sx = Math.round(cx / texelSize) * texelSize;
    const sy = Math.round(cy / texelSize) * texelSize;
    const projection = orthographic(
      sx - radius,
      sx + radius,
      sy - radius,
      sy + radius,
      -(cz + radius + CASTER_REACH),
      -(cz - radius),
    );
    cascades.push({ viewProj: multiply(projection, view), far: end, texelSize });
    start = end;
  }
  return cascades;
}
