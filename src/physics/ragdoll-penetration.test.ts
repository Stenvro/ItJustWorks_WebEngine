import { beforeAll, describe, expect, it } from 'vitest';
import type { Mat4 } from '../render/math.ts';
import type { CollisionBody, CollisionData } from './collision-data.ts';
import { CollisionMatrix, Layer } from './collision-layers.ts';
import { GRAVITY, initPhysics, PHYSICS_STEP, PhysicsWorld } from './physics-world.ts';
import { RagdollPenetration } from './ragdoll-penetration.ts';

/** The dead bodies' layer collides with the ground, as the vanilla COLL records have it. */
const matrix = new CollisionMatrix([
  {
    formId: 1,
    editorId: 'L_GROUND',
    index: Layer.ground,
    name: '',
    flags: 0,
    collidesWith: [2],
  },
  {
    formId: 2,
    editorId: 'L_DEADBIP',
    index: Layer.deadBip,
    name: '',
    flags: 0,
    collidesWith: [1, 2],
  },
]);

const at = (z: number): Mat4 => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, z, 1]);

function bone(name: string, z: number): CollisionBody {
  return {
    node: name,
    transform: at(z),
    motion: 'dynamic',
    phantom: false,
    layer: Layer.deadBip,
    mass: 2,
    inertia: [0.01, 0.01, 0.01],
    centerOfMass: [0, 0, 0],
    friction: 0.5,
    restitution: 0,
    linearDamping: 0.1,
    angularDamping: 0.1,
    gravityFactor: 1,
    maxLinearVelocity: 100,
    maxAngularVelocity: 30,
    quality: 0,
    shapes: [{ type: 'sphere', layer: Layer.deadBip, material: 0, center: [0, 0, 0], radius: 5 }],
  };
}

/**
 * A chain of three bodies: a root at 40, a middle at 10 (held to the root at 25) and a leaf
 * under the floor at −30 (held to the middle at −10).
 */
function chain(): CollisionData {
  return {
    bodies: [bone('Root', 40), bone('Middle', 10), bone('Leaf', -30)],
    constraints: [
      {
        bodyA: 1,
        bodyB: 0,
        data: { type: 'ball-and-socket', pivotA: [0, 0, 15], pivotB: [0, 0, -15] },
      },
      {
        bodyA: 2,
        bodyB: 1,
        data: { type: 'ball-and-socket', pivotA: [0, 0, 20], pivotB: [0, 0, -20] },
      },
    ],
    skipped: [],
  };
}

beforeAll(async () => {
  await initPhysics();
});

describe('ragdoll penetration', () => {
  it('lets a limb under the ground pass back up through it, then gives it its collision back', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    physics.addMesh(
      Float32Array.of(-500, -500, 0, 500, -500, 0, 500, 500, 0, -500, 500, 0),
      Uint32Array.of(0, 1, 2, 0, 2, 3),
      Layer.ground,
      { reference: 0, kind: 'landscape' },
      true,
    );
    const placed = physics.addObject(chain(), at(0), { reference: 7, kind: 'actor' }, false);
    physics.setMotion(placed, false);
    const watch = new RagdollPenetration(physics, placed, 7);
    const leaf = placed.bodies[2];
    if (!leaf) throw new Error('no leaf');
    // The ray from the middle's pivot (25) to the leaf's (−10) meets the floor: the leaf passes
    // through everything and is pushed back up along the floor's normal.
    physics.step(PHYSICS_STEP);
    const before = leaf.body.linvel().z;
    watch.update(PHYSICS_STEP);
    expect(watch.penetrations).toBe(1);
    expect(physics.passesThrough(leaf)).toBe(true);
    expect(physics.passesThrough(placed.bodies[1] ?? leaf)).toBe(false);
    expect(leaf.body.linvel().z).toBeGreaterThan(before);
    // Its time over, every bone collides again and nothing is watched any more.
    for (let i = 0; i < 400; i++) {
      physics.step(PHYSICS_STEP);
      watch.update(PHYSICS_STEP);
    }
    expect(watch.watching).toBe(false);
    expect(physics.passesThrough(leaf)).toBe(false);
    physics.free();
  });

  it('leaves a ragdoll that is still keyframed alone', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const placed = physics.addObject(chain(), at(0), { reference: 7, kind: 'actor' }, false);
    physics.keyframe(placed);
    const watch = new RagdollPenetration(physics, placed, 7);
    physics.step(PHYSICS_STEP);
    expect(watch.update(PHYSICS_STEP)).toBe(true);
    expect(watch.penetrations).toBe(0);
    physics.free();
  });
});
