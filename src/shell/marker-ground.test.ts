import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { HAVOK_SCALE } from '../physics/collision-data.ts';
import { CollisionMatrix, Layer } from '../physics/collision-layers.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from '../physics/physics-world.ts';
import { enterFloor, MARKER_GROUND_LIFT, markerGround } from './marker-ground.ts';

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

  it("looks from under a table's top in front of a chair whose marker is on the floor", () => {
    // A table top 24 units over the floor: an enter's start looked for from its marker's height
    // finds the floor; looked for from a lift over a lift (32 over the marker), the table top.
    const physics = world();
    const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const collider = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(h(40), h(40), h(2)).setTranslation(0, 0, h(22)),
      body,
    );
    physics.register(collider, Layer.static, { reference: 3, kind: 'object' });
    physics.step(1 / 60);
    expect(markerGround(physics, [0, 0, 0.03])).toBeCloseTo(0, 1);
    expect(markerGround(physics, [0, 0, 0.03 + MARKER_GROUND_LIFT])).toBeCloseTo(24, 1);
  });

  it('finds the ground far below a marker in the air (an ambush hole)', () => {
    expect(markerGround(world(), [0, 0, 1000])).toBeCloseTo(0, 1);
    expect(markerGround(world(), [0, 0, -200])).toBeCloseTo(-570, 1);
  });
});

describe('enterFloor', () => {
  /** Spots this far above or below are on another floor (actor-furniture.ts SPOT_HEIGHT). */
  const sameFloor = 160;

  it("begins on the user's floor when the furniture is on it", () => {
    const asked: (readonly number[])[] = [];
    const ground = (at: readonly [number, number, number]): number => {
      asked.push(at);
      return -999;
    };
    expect(enterFloor(100, [0, 0, 140], sameFloor, ground)).toBe(100);
    expect(asked).toEqual([]);
  });

  it("looks for the ground on another floor from the marker's own height", () => {
    // The ground callback adds its own lift over the marker (markerGround): handed a point
    // already lifted, it started over a table's top in front of a chair and stood the enter on it.
    const asked: (readonly number[])[] = [];
    const ground = (at: readonly [number, number, number]): number => {
      asked.push(at);
      return at[2] - 3;
    };
    expect(enterFloor(0, [10, 20, 600], sameFloor, ground)).toBe(597);
    expect(asked).toEqual([[10, 20, 600]]);
  });

  it("stays at the marker's height when no ground is found", () => {
    expect(enterFloor(0, [10, 20, 600], sameFloor, () => undefined)).toBe(600);
    expect(enterFloor(0, [10, 20, 600], sameFloor, undefined)).toBe(600);
  });
});
