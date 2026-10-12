// Rays against placed model geometry (CPU): where a placed decal's projection meets the first
// surface, as the engine finds it when it builds the decal. Platform-independent.

import { invert } from './frustum.ts';
import { multiply, type Mat4, type Vec3 } from './math.ts';
import type { ModelPart } from './model-data.ts';

/** A model part placed in the world. */
export interface PlacedPart {
  readonly part: ModelPart;
  /** Instance world matrix (the part's own matrix is applied on top). */
  readonly instanceWorld: Mat4;
  /** World bounding sphere. */
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

/** Distance along a unit ray to a sphere's near side, or Infinity if it misses. */
function raySphere(
  origin: Vec3,
  direction: Vec3,
  center: readonly number[],
  radius: number,
): number {
  const ox = origin[0] - (center[0] ?? 0);
  const oy = origin[1] - (center[1] ?? 0);
  const oz = origin[2] - (center[2] ?? 0);
  const b = ox * direction[0] + oy * direction[1] + oz * direction[2];
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c <= 0) return 0; // inside
  const discriminant = b * b - c;
  if (b > 0 || discriminant < 0) return Infinity;
  return -b - Math.sqrt(discriminant);
}

/** Möller–Trumbore: distance along the ray to the triangle, or Infinity (both sides hit). */
export function rayTriangle(origin: Vec3, direction: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  const e1x = b[0] - a[0];
  const e1y = b[1] - a[1];
  const e1z = b[2] - a[2];
  const e2x = c[0] - a[0];
  const e2y = c[1] - a[1];
  const e2z = c[2] - a[2];
  const px = direction[1] * e2z - direction[2] * e2y;
  const py = direction[2] * e2x - direction[0] * e2z;
  const pz = direction[0] * e2y - direction[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return Infinity;
  const inverse = 1 / det;
  const tx = origin[0] - a[0];
  const ty = origin[1] - a[1];
  const tz = origin[2] - a[2];
  const u = (tx * px + ty * py + tz * pz) * inverse;
  if (u < 0 || u > 1) return Infinity;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (direction[0] * qx + direction[1] * qy + direction[2] * qz) * inverse;
  if (v < 0 || u + v > 1) return Infinity;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inverse;
  return t >= 0 ? t : Infinity;
}

/** Distance along a ray (model space of the part) to its nearest triangle. */
function rayPart(part: ModelPart, origin: Vec3, direction: Vec3, maxDistance: number): number {
  const { layout, vertices, indices } = part;
  const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
  // SSE geometry always stores positions as float32 (the full-precision flag aside).
  const position = (index: number): Vec3 => {
    const base = index * layout.stride;
    return [
      view.getFloat32(base, true),
      view.getFloat32(base + 4, true),
      view.getFloat32(base + 8, true),
    ];
  };
  let nearest = maxDistance;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const t = rayTriangle(
      origin,
      direction,
      position(indices[i] ?? 0),
      position(indices[i + 1] ?? 0),
      position(indices[i + 2] ?? 0),
    );
    if (t < nearest) nearest = t;
  }
  return nearest;
}

/**
 * Distance along a world ray (unit direction) to the first opaque surface of the placed
 * parts within `maxDistance`, or undefined if there is none. With `anySurface`, water,
 * effect and blended surfaces count too (development picking).
 */
export function raycastParts(
  parts: Iterable<PlacedPart>,
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
  anySurface = false,
): number | undefined {
  let nearest = maxDistance;
  for (const placed of parts) {
    const material = placed.part.material;
    // Only surfaces that decals can lie on: no water, effects or blended layers.
    const solid = material?.kind === 'lighting' && ((placed.part.alpha?.flags ?? 0) & 1) === 0;
    if (!solid && !anySurface) continue;
    const entry = raySphere(origin, direction, placed.center, placed.radius);
    if (entry >= nearest) continue;
    const world = multiply(placed.instanceWorld, placed.part.world);
    const inverse = invert(world);
    if (!inverse) continue;
    // The ray in the part's model space (distances scale with the matrix).
    const at = (m: Mat4, i: number): number => m[i] ?? 0;
    const o: Vec3 = [
      at(inverse, 0) * origin[0] +
        at(inverse, 4) * origin[1] +
        at(inverse, 8) * origin[2] +
        at(inverse, 12),
      at(inverse, 1) * origin[0] +
        at(inverse, 5) * origin[1] +
        at(inverse, 9) * origin[2] +
        at(inverse, 13),
      at(inverse, 2) * origin[0] +
        at(inverse, 6) * origin[1] +
        at(inverse, 10) * origin[2] +
        at(inverse, 14),
    ];
    const d: Vec3 = [
      at(inverse, 0) * direction[0] + at(inverse, 4) * direction[1] + at(inverse, 8) * direction[2],
      at(inverse, 1) * direction[0] + at(inverse, 5) * direction[1] + at(inverse, 9) * direction[2],
      at(inverse, 2) * direction[0] +
        at(inverse, 6) * direction[1] +
        at(inverse, 10) * direction[2],
    ];
    const scale = Math.hypot(d[0], d[1], d[2]);
    if (scale <= 0) continue;
    const unit: Vec3 = [d[0] / scale, d[1] / scale, d[2] / scale];
    const t = rayPart(placed.part, o, unit, nearest * scale) / scale;
    if (t < nearest) nearest = t;
  }
  return nearest < maxDistance ? nearest : undefined;
}
