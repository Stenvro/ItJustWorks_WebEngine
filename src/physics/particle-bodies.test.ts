import { beforeAll, describe, expect, it } from 'vitest';
import { identity, type Mat4 } from '../render/math.ts';
import type { CollisionBody, CollisionData } from './collision-data.ts';
import { CollisionMatrix, Layer } from './collision-layers.ts';
import { PARTICLE_BODY_TIMEOUT, PhysicsParticleBodies } from './particle-bodies.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from './physics-world.ts';

/** Debris collides with static and with itself (as the vanilla COLL records have it). */
const matrix = new CollisionMatrix([
  { formId: 1, editorId: 'L_STATIC', index: Layer.static, name: '', flags: 0, collidesWith: [2] },
  {
    formId: 2,
    editorId: 'L_DEBRIS_LARGE',
    index: Layer.debrisLarge,
    name: '',
    flags: 0,
    collidesWith: [1, 2],
  },
]);

/** A box between two corners (game units) as a convex shape of a layer. */
function box(
  min: [number, number, number],
  max: [number, number, number],
  layer: number,
): CollisionBody['shapes'][number] {
  const points: number[] = [];
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) points.push(x, y, z);
  }
  return { type: 'convex', layer, material: 0, points: Float32Array.from(points), radius: 0 };
}

function body(
  motion: CollisionBody['motion'],
  shape: CollisionBody['shapes'][number],
): CollisionBody {
  return {
    node: 'Rock',
    transform: identity(),
    motion,
    phantom: false,
    layer: shape.layer,
    mass: motion === 'dynamic' ? 50 : 0,
    inertia: [10, 10, 10],
    centerOfMass: [0, 0, 0],
    friction: 0.5,
    restitution: 0.4,
    linearDamping: 0.1,
    angularDamping: 0.05,
    gravityFactor: 1,
    maxLinearVelocity: 104.4,
    maxAngularVelocity: 31.57,
    quality: 4,
    solverDeactivation: 1,
    shapes: [shape],
  };
}

const rock: CollisionData = {
  bodies: [body('dynamic', box([-5, -5, -5], [5, 5, 5], Layer.debrisLarge))],
  skipped: [],
};

const at = (x: number, y: number, z: number): Mat4 => {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
};

describe('mesh particles in the physics world', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it("lands on the world's shapes instead of the ground under the effect", () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    // A ledge 200 units above the effect's origin.
    physics.addObject(
      {
        bodies: [body('fixed', box([-200, -200, 180], [200, 200, 200], Layer.static))],
        skipped: [],
      },
      identity(),
      { reference: 1, kind: 'object' },
    );
    let now = 0;
    const bodies = new PhysicsParticleBodies(physics, () => now);
    const handle = bodies.add(rock, at(0, 0, 300), [100, 0, 0], [0, 0, 3]);
    expect(handle).toBeDefined();
    for (let i = 0; i < 180; i++) {
      physics.step(1 / 60);
      now += 1 / 60;
    }
    const pose = identity();
    expect(bodies.pose(handle ?? -1, pose)).toBe(true);
    // Resting on the ledge's top (z 200) by its half height, after sliding along it.
    expect(pose[14]).toBeGreaterThan(195);
    expect(pose[14]).toBeLessThan(215);
    expect(pose[12]).toBeGreaterThan(0);
    bodies.remove(handle ?? -1);
    expect(bodies.size).toBe(0);
    expect(bodies.pose(handle ?? -1, pose)).toBe(false);
  });

  it('leaves the bodies no system asks for behind', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    let now = 0;
    const bodies = new PhysicsParticleBodies(physics, () => now);
    const kept = bodies.add(rock, at(0, 0, 0), [0, 0, 0], [0, 0, 0]) ?? -1;
    bodies.add(rock, at(100, 0, 0), [0, 0, 0], [0, 0, 0]);
    expect(bodies.size).toBe(2);
    const pose = identity();
    for (let i = 0; i < 4; i++) {
      now += PARTICLE_BODY_TIMEOUT / 2 + 0.01;
      bodies.pose(kept, pose);
    }
    expect(bodies.size).toBe(1);
    expect(bodies.pose(kept, pose)).toBe(true);
  });
});
