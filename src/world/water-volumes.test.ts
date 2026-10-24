import { describe, expect, it } from 'vitest';
import type { CollisionBody, CollisionData, CollisionShape } from '../physics/collision-data.ts';
import { Layer } from '../physics/collision-layers.ts';
import { identity } from '../render/math.ts';
import { surfaceOver, volumeSurface, waterVolumes } from './water-volumes.ts';

const WATER_TYPE = 0x18;

const translation = (x: number, y: number, z: number): Float32Array => {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
};

const body = (layer: number, shapes: readonly CollisionShape[]): CollisionBody => ({
  node: 'Water',
  transform: identity(),
  motion: 'fixed',
  phantom: true,
  layer,
  mass: 0,
  inertia: [0, 0, 0],
  centerOfMass: [0, 0, 0],
  friction: 0.5,
  restitution: 0.4,
  linearDamping: 0,
  angularDamping: 0,
  gravityFactor: 1,
  maxLinearVelocity: 0,
  maxAngularVelocity: 0,
  quality: 0,
  solverDeactivation: 1,
  shapes,
});

/** water1024.nif's volume: a box 1024 wide and deep under its surface. */
const water1024: CollisionData = {
  bodies: [
    body(Layer.water, [
      {
        type: 'box',
        layer: Layer.water,
        material: 0,
        halfExtents: [512, 512, 512],
        transform: translation(0, 0, -512),
        radius: 0,
      },
    ]),
  ],
  skipped: [],
};

describe('water volumes', () => {
  it("are the water layer's shapes of a placed water activator", () => {
    const [volume, ...rest] = waterVolumes(water1024, translation(100, 200, 50), WATER_TYPE);
    expect(rest).toHaveLength(0);
    if (!volume) throw new Error('no volume');
    // Under the surface, above it, and beside or below the volume.
    expect(volumeSurface(volume, 100, 200, 0)).toBeCloseTo(50);
    expect(volumeSurface(volume, 600, 700, 900)).toBeCloseTo(50);
    expect(volumeSurface(volume, 700, 200, 0)).toBeUndefined();
    expect(volumeSurface(volume, 100, 200, 50 - 1100)).toBeUndefined();
  });

  it('follow the reference: turned and scaled', () => {
    // Turned 90° about z and twice the size: 2048 units deep, the surface still at z 50.
    const world = new Float32Array([0, 2, 0, 0, -2, 0, 0, 0, 0, 0, 2, 0, 0, 0, 50, 1]);
    const volumes = waterVolumes(water1024, world, WATER_TYPE);
    expect(surfaceOver(volumes, 1000, -1000, -1900)).toEqual({ height: 50, type: WATER_TYPE });
    expect(surfaceOver(volumes, 1100, 0, 0)).toBeUndefined();
  });

  it('leave out water seen but not entered, and take other shapes by their bounds', () => {
    const solid: CollisionData = {
      bodies: [
        body(
          Layer.static,
          (water1024.bodies[0]?.shapes ?? []).map((shape) => ({ ...shape, layer: Layer.static })),
        ),
      ],
      skipped: [],
    };
    expect(waterVolumes(solid, identity(), WATER_TYPE)).toHaveLength(0);
    expect(waterVolumes(undefined, identity(), WATER_TYPE)).toHaveLength(0);
    const hull: CollisionData = {
      bodies: [
        body(Layer.water, [
          {
            type: 'convex',
            layer: Layer.water,
            material: 0,
            points: new Float32Array([-100, -50, -300, 100, 50, -300, 0, 0, 20]),
            radius: 0,
          },
        ]),
      ],
      skipped: [],
    };
    const volumes = waterVolumes(hull, identity(), WATER_TYPE);
    expect(surfaceOver(volumes, 90, 40, -200)?.height).toBeCloseTo(20);
    expect(surfaceOver(volumes, 90, 60, -200)).toBeUndefined();
  });
});
