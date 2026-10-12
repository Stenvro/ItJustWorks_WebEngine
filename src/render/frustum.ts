// View frustum tests and matrix helpers for culling and shadow cascades. Platform-independent.

import type { Mat4, Vec3 } from './math.ts';

/** Plane as (normal x, y, z, d): points p with n·p + d ≥ 0 are inside. */
export type Plane = readonly [number, number, number, number];

/** Inverse of a 4×4 matrix (column-major), or undefined if it is singular. */
export function invert(m: Mat4): Mat4 | undefined {
  const a = (i: number): number => m[i] ?? 0;
  const [a00, a01, a02, a03] = [a(0), a(1), a(2), a(3)];
  const [a10, a11, a12, a13] = [a(4), a(5), a(6), a(7)];
  const [a20, a21, a22, a23] = [a(8), a(9), a(10), a(11)];
  const [a30, a31, a32, a33] = [a(12), a(13), a(14), a(15)];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-30) return undefined;
  const inv = 1 / det;
  return new Float32Array([
    (a11 * b11 - a12 * b10 + a13 * b09) * inv,
    (a02 * b10 - a01 * b11 - a03 * b09) * inv,
    (a31 * b05 - a32 * b04 + a33 * b03) * inv,
    (a22 * b04 - a21 * b05 - a23 * b03) * inv,
    (a12 * b08 - a10 * b11 - a13 * b07) * inv,
    (a00 * b11 - a02 * b08 + a03 * b07) * inv,
    (a32 * b02 - a30 * b05 - a33 * b01) * inv,
    (a20 * b05 - a22 * b02 + a23 * b01) * inv,
    (a10 * b10 - a11 * b08 + a13 * b06) * inv,
    (a01 * b08 - a00 * b10 - a03 * b06) * inv,
    (a30 * b04 - a31 * b02 + a33 * b00) * inv,
    (a21 * b02 - a20 * b04 - a23 * b00) * inv,
    (a11 * b07 - a10 * b09 - a12 * b06) * inv,
    (a00 * b09 - a01 * b07 + a02 * b06) * inv,
    (a31 * b01 - a30 * b03 - a32 * b00) * inv,
    (a20 * b03 - a21 * b01 + a22 * b00) * inv,
  ]);
}

/** Projects a point with a 4×4 matrix (divides by w). */
export function project(m: Mat4, p: Vec3): [number, number, number] {
  const [x, y, z] = p;
  const c = (row: number): number =>
    (m[row] ?? 0) * x + (m[4 + row] ?? 0) * y + (m[8 + row] ?? 0) * z + (m[12 + row] ?? 0);
  const w = c(3);
  return [c(0) / w, c(1) / w, c(2) / w];
}

/**
 * Side planes of a view-projection's frustum (left, right, bottom, top) and its near plane;
 * the far plane is left out (reversed-Z projections reach to infinity).
 */
export function frustumPlanes(viewProj: Mat4): Plane[] {
  const row = (r: number): [number, number, number, number] => [
    viewProj[r] ?? 0,
    viewProj[4 + r] ?? 0,
    viewProj[8 + r] ?? 0,
    viewProj[12 + r] ?? 0,
  ];
  const [r0, r1, r2, r3] = [row(0), row(1), row(2), row(3)];
  const combine = (a: readonly number[], b: readonly number[], sign: number): Plane => {
    const p = [0, 1, 2, 3].map((i) => (a[i] ?? 0) + sign * (b[i] ?? 0));
    const length = Math.hypot(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0) || 1;
    return [(p[0] ?? 0) / length, (p[1] ?? 0) / length, (p[2] ?? 0) / length, (p[3] ?? 0) / length];
  };
  return [
    combine(r3, r0, 1), // left: w + x ≥ 0
    combine(r3, r0, -1), // right: w − x ≥ 0
    combine(r3, r1, 1), // bottom
    combine(r3, r1, -1), // top
    combine(r3, r2, -1), // near (reversed Z: z ≤ w)
  ];
}

/** Whether a sphere is at least partly inside all planes. */
export function sphereVisible(planes: readonly Plane[], center: Vec3, radius: number): boolean {
  for (const [nx, ny, nz, d] of planes) {
    if (nx * center[0] + ny * center[1] + nz * center[2] + d < -radius) return false;
  }
  return true;
}
