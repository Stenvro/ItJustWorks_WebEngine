import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { HAVOK_SCALE } from '../physics/collision-data.ts';
import { CollisionMatrix, Layer } from '../physics/collision-layers.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from '../physics/physics-world.ts';
import { markerGround } from './marker-ground.ts';

const matrix = new CollisionMatrix([
  { formId: 1, editorId: 'L_STATIC', index: Layer.static, name: '', flags: 0, collidesWith: [2] },
  {
    formId: 2,
    editorId: 'L_CHARCONTROLLER',
    index: Layer.charController,
    name: '',
    flags: 0,
    collidesWith: [1, 2],
  },
]);
const h = (v: number): number => v / HAVOK_SCALE;

beforeAll(async () => {
  await initPhysics();
});

/**
 * A world with a floor that is a mesh (two triangles, open from below) with its top at z 0, over
 * land 570 units down (Riften's market over the land under the city).
 */
function world(): PhysicsWorld {
  const physics = new PhysicsWorld(matrix, GRAVITY);
  const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const mesh = (z: number, reference: number): void => {
    const s = h(1000);
    const vertices = new Float32Array([-s, -s, h(z), s, -s, h(z), s, s, h(z), -s, s, h(z)]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const collider = physics.world.createCollider(
      RAPIER.ColliderDesc.trimesh(vertices, indices),
      body,
    );
    physics.register(collider, Layer.static, { reference, kind: 'object' });
  };
  mesh(0, 1);
  mesh(-570, 2);
  physics.step(1 / 60);
  return physics;
}

describe('markerGround', () => {
  it('finds the floor a marker stands on, not the land under it', () => {
    // A counter's marker a hair above the floor's top (as placed in the Creation Kit).
    expect(markerGround(world(), [0, 0, 0.03])).toBeCloseTo(0, 1);
  });

  it('finds the ground far below a marker in the air (an ambush hole)', () => {
    expect(markerGround(world(), [0, 0, 1000])).toBeCloseTo(0, 1);
    expect(markerGround(world(), [0, 0, -200])).toBeCloseTo(-570, 1);
  });
});
