import { beforeAll, describe, expect, it } from 'vitest';
import type { Mat4 } from '../render/math.ts';
import { CharacterBody } from './character.ts';
import type { CollisionBody, CollisionData } from './collision-data.ts';
import { CollisionMatrix, Layer } from './collision-layers.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from './physics-world.ts';

const IDENTITY: Mat4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Static and the character controller collide (as the vanilla COLL records have it). */
const matrix = new CollisionMatrix([
  { formId: 1, editorId: 'L_STATIC', index: Layer.static, name: '', flags: 0, collidesWith: [2] },
  {
    formId: 2,
    editorId: 'L_CHARCONTROLLER',
    index: Layer.charController,
    name: '',
    flags: 0,
    collidesWith: [1],
  },
]);

function body(shape: CollisionBody['shapes'][number]): CollisionBody {
  return {
    node: 'Body',
    transform: IDENTITY,
    motion: 'fixed',
    phantom: false,
    layer: Layer.static,
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
    shapes: [shape],
  };
}

const collision = (...bodies: CollisionBody[]): CollisionData => ({ bodies, skipped: [] });

/** A box shape between two corners (game units), of a material. */
function box(
  min: [number, number, number],
  max: [number, number, number],
  material = 0,
): CollisionBody['shapes'][number] {
  const points: number[] = [];
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) points.push(x, y, z);
  }
  return {
    type: 'convex',
    layer: Layer.static,
    material,
    points: Float32Array.from(points),
    radius: 0,
  };
}

/** A wall: the box from x 0 to 20, y −100 to 100, z 0 to 200 (game units). */
function wall(): CollisionData {
  return collision(body(box([0, -100, 0], [20, 100, 200])));
}

/** A stair material (MATT with the stairs flag), as the plugins number them. */
const STAIRS = 899511101;

const settings = (stairMaterials: ReadonlySet<number>) => ({
  maxSlope: 60,
  fallingGravity: 1,
  unsupportedGravity: 1,
  stairMaterials,
  stairHeight: 32,
});

beforeAll(async () => {
  await initPhysics();
});

describe('the physics world', () => {
  it('builds hulls of points that lie in one plane (Havok gives them its convex radius)', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    // The Dragon Priest dagger's shapes: eight points, all at z 0.
    const flat = Float32Array.from([
      -3, -9, 0, 1, -9, 0, -3, 31, 0, 1, 31, 0, -2, 0, 0, 0, 0, 0, -2, 20, 0, 0, 20, 0,
    ]);
    const placed = physics.addObject(
      collision(
        body({ type: 'convex', layer: Layer.static, material: 0, points: flat, radius: 3.5 }),
      ),
      IDENTITY,
      { reference: 1, kind: 'object' },
    );
    expect(placed.colliders).toHaveLength(1);
    physics.free();
  });

  it('answers queries about placed collision only after a step', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    expect(physics.queriesCurrent).toBe(true);
    physics.addObject(wall(), IDENTITY, { reference: 1, kind: 'object' });
    expect(physics.queriesCurrent).toBe(false);
    physics.step(1 / 60);
    expect(physics.queriesCurrent).toBe(true);
    expect(
      physics.raycast([-50, 0, 100], [1, 0, 0], 100, Layer.charController)?.distance,
    ).toBeCloseTo(50, 1);
    physics.free();
  });
});

describe('the character controller', () => {
  it('is pushed out of what it stands in (penetration recovery)', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    physics.addObject(wall(), IDENTITY, { reference: 1, kind: 'object' });
    physics.step(1 / 60);
    // 14.42 + the 3.5 shell reach 17.9 from the centre: at x −10 it is 8 into the wall.
    const character = new CharacterBody(
      physics,
      { radius: 14.42, height: 131.84 },
      settings(new Set()),
      [-10, 0, 0],
      { reference: 0x14, kind: 'actor' },
    );
    character.recover();
    const [x, y, z] = character.feet;
    expect(x).toBeLessThan(-17.5);
    expect(x).toBeGreaterThan(-19);
    expect(y).toBeCloseTo(0, 3);
    expect(z).toBeCloseTo(0, 3);
    character.free();
    physics.free();
  });

  it('climbs stairs of a stair material, step by step', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    // A floor, then five treads 24 high and 28 deep along +y (the Volkihar courtyard's).
    const shapes = [box([-200, -300, -20], [200, 0, 0], STAIRS)];
    for (let i = 1; i <= 5; i++)
      shapes.push(box([-200, (i - 1) * 28, 0], [200, 400, i * 24], STAIRS));
    physics.addObject(collision(...shapes.map((shape) => body(shape))), IDENTITY, {
      reference: 1,
      kind: 'object',
    });
    physics.step(1 / 60);
    const character = new CharacterBody(
      physics,
      { radius: 14.42, height: 131.84 },
      settings(new Set([STAIRS])),
      [0, -100, 0],
      { reference: 0x14, kind: 'actor' },
    );
    // One second at 300 units a second: up the five treads and on along the top one.
    for (let i = 0; i < 60; i++) {
      character.velocity = [0, 300];
      character.step(1 / 60);
      physics.step(1 / 60);
    }
    // On the top tread, at about walking speed.
    // (The controller keeps its skin, 0.7 units, above the ground.)
    expect(character.feet[2]).toBeGreaterThan(119.5);
    expect(character.feet[2]).toBeLessThan(121.5);
    // 278 of the 300 units along.
    expect(character.feet[1]).toBeGreaterThan(170);
    character.free();
    physics.free();
  });

  it('steps off the stairs only onto ground actors walk', () => {
    const climb = (
      walkable: ((x: number, y: number, z: number) => boolean) | undefined,
    ): number => {
      const physics = new PhysicsWorld(matrix, GRAVITY);
      // A floor and a raised floor piece 20 high, of a plain material.
      physics.addObject(
        collision(
          body(box([-200, -300, -20], [200, 0, 0])),
          body(box([-200, 0, 0], [200, 300, 20])),
        ),
        IDENTITY,
        { reference: 1, kind: 'object' },
      );
      physics.step(1 / 60);
      const character = new CharacterBody(
        physics,
        { radius: 14.42, height: 131.84 },
        settings(new Set([STAIRS])),
        [0, -100, 0],
        { reference: 0x14, kind: 'actor' },
      );
      character.walkable = walkable;
      for (let i = 0; i < 60; i++) {
        character.velocity = [0, 300];
        character.step(1 / 60);
        physics.step(1 / 60);
      }
      const z = character.feet[2];
      character.free();
      physics.free();
      return z;
    };
    expect(climb(undefined)).toBeLessThan(5);
    expect(climb(() => false)).toBeLessThan(5);
    expect(climb(() => true)).toBeGreaterThan(19);
  });
});
