// Where placed water can be entered. A water activator's model holds its volume as phantoms on
// the WATER collision layer (water1024.nif: a box 1024 units deep under the surface, the pool
// of Whiterun's Wind District two boxes); water whose model has none (the streams running down
// Whiterun's stairs) is only seen and heard: nobody swims or goes under in it. Swimming and the
// sound under water test these volumes; the cell's own water plane has no bottom. 27 vanilla
// meshes hold such volumes: 47 boxes, 2 convex hulls, 1 capsule (the last two are taken as
// their boxes). Platform-independent. Notes: docs/formats/nif.md ("Water volumes").

import type { CollisionData, CollisionShape } from '../physics/collision-data.ts';
import { Layer } from '../physics/collision-layers.ts';
import { invert } from '../render/frustum.ts';
import { multiply, transformPoint, type Mat4, type Vec3 } from '../render/math.ts';

/** A box of water in the world, of a water type (WATR). */
export interface WaterVolume {
  readonly type: number;
  /** Box space → world (the reference's scale included). */
  readonly toWorld: Mat4;
  /** World → box space. */
  readonly toLocal: Mat4;
  /** Half the box's size along its axes, box space. */
  readonly halfExtents: Vec3;
}

/** The water volumes of a placed water activator: its model's WATER-layer shapes. */
export function waterVolumes(
  collision: CollisionData | undefined,
  world: Mat4,
  type: number,
): WaterVolume[] {
  const volumes: WaterVolume[] = [];
  for (const body of collision?.bodies ?? []) {
    for (const shape of body.shapes) {
      if (shape.layer !== Layer.water && body.layer !== Layer.water) continue;
      const box = shapeBox(shape);
      if (!box) continue;
      const toWorld = multiply(multiply(world, body.transform), box.transform);
      const toLocal = invert(toWorld);
      if (toLocal) volumes.push({ type, toWorld, toLocal, halfExtents: box.halfExtents });
    }
  }
  return volumes;
}

/**
 * The surface of a volume over a point that lies within its outline and not below its bottom
 * (above the water is fine: the caller compares), else undefined.
 */
export function volumeSurface(
  volume: WaterVolume,
  x: number,
  y: number,
  z: number,
): number | undefined {
  const [hx, hy, hz] = volume.halfExtents;
  const [lx, ly, lz] = transformPoint(volume.toLocal, [x, y, z]);
  if (Math.abs(lx) > hx || Math.abs(ly) > hy || lz < -hz) return undefined;
  // Where the vertical through the point meets the top face's plane.
  const m = volume.toWorld;
  const [px, py, pz] = transformPoint(m, [0, 0, hz]);
  const [nx = 0, ny = 0, nz = 0] = [m[8], m[9], m[10]];
  if (Math.abs(nz) < 1e-6) return pz;
  return pz + (nx * (px - x) + ny * (py - y)) / nz;
}

/** The highest surface of the volumes over a point (see volumeSurface) and its water type. */
export function surfaceOver(
  volumes: readonly WaterVolume[],
  x: number,
  y: number,
  z: number,
): { height: number; type: number } | undefined {
  let found: { height: number; type: number } | undefined;
  for (const volume of volumes) {
    const height = volumeSurface(volume, x, y, z);
    if (height !== undefined && (!found || height > found.height)) {
      found = { height, type: volume.type };
    }
  }
  return found;
}

/** A shape as a box: boxes as they are; hulls, capsules, spheres and meshes by their bounds. */
function shapeBox(shape: CollisionShape): { transform: Mat4; halfExtents: Vec3 } | undefined {
  if (shape.type === 'box') {
    const r = shape.radius;
    return {
      transform: shape.transform,
      halfExtents: [shape.halfExtents[0] + r, shape.halfExtents[1] + r, shape.halfExtents[2] + r],
    };
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const grow = (x: number, y: number, z: number, r: number): void => {
    min[0] = Math.min(min[0], x - r);
    min[1] = Math.min(min[1], y - r);
    min[2] = Math.min(min[2], z - r);
    max[0] = Math.max(max[0], x + r);
    max[1] = Math.max(max[1], y + r);
    max[2] = Math.max(max[2], z + r);
  };
  const points = (values: ArrayLike<number>, r: number): void => {
    for (let i = 0; i + 2 < values.length; i += 3) {
      grow(values[i] ?? 0, values[i + 1] ?? 0, values[i + 2] ?? 0, r);
    }
  };
  switch (shape.type) {
    case 'convex':
      points(shape.points, shape.radius);
      break;
    case 'mesh':
      points(shape.vertices, 0);
      break;
    case 'sphere':
      grow(...shape.center, shape.radius);
      break;
    case 'capsule':
      grow(...shape.a, shape.radius);
      grow(...shape.b, shape.radius);
      break;
    case 'cylinder':
      grow(...shape.a, shape.radius + shape.shell);
      grow(...shape.b, shape.radius + shape.shell);
      break;
  }
  if (!(min[0] <= max[0])) return undefined;
  const transform = new Float32Array(16);
  transform[0] = transform[5] = transform[10] = transform[15] = 1;
  transform[12] = (min[0] + max[0]) / 2;
  transform[13] = (min[1] + max[1]) / 2;
  transform[14] = (min[2] + max[2]) / 2;
  return {
    transform,
    halfExtents: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2],
  };
}
