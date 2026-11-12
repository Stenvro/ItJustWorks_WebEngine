// What the physics frame costs in Helgen's opening (docs/rendering.md, "The opening's frame"):
// a world step without World.step's walk over every body, the contact filter's ignored pairs by
// number, and the character controllers' sweeps filtered by Rapier's groups. Each keeps the
// results the slower way gave.

import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Mat4 } from '../render/math.ts';
import { CharacterBody } from './character.ts';
import type { CollisionBody, CollisionData } from './collision-data.ts';
import { CollisionMatrix, Layer } from './collision-layers.ts';
import { WaterPhysics } from './water-physics.ts';
import {
  GRAVITY,
  HandlePairs,
  initPhysics,
  PhysicsWorld,
  QueryGroups,
  stepWorld,
} from './physics-world.ts';

const IDENTITY: Mat4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Static, clutter and BIPED_NO_CC meet the controller; BIPED does not (as the COLL records). */
const matrix = new CollisionMatrix([
  {
    formId: 1,
    editorId: 'L_STATIC',
    index: Layer.static,
    name: '',
    flags: 0,
    collidesWith: [2, 3, 4, 5],
  },
  {
    formId: 2,
    editorId: 'L_CHARCONTROLLER',
    index: Layer.charController,
    name: '',
    flags: 0,
    collidesWith: [1, 2, 4],
  },
  { formId: 3, editorId: 'L_BIPED', index: Layer.biped, name: '', flags: 0, collidesWith: [1] },
  {
    formId: 4,
    editorId: 'L_BIPED_NO_CC',
    index: Layer.bipedNoCc,
    name: '',
    flags: 0,
    collidesWith: [1, 2],
  },
  { formId: 5, editorId: 'L_CLUTTER', index: Layer.clutter, name: '', flags: 0, collidesWith: [1] },
]);

function box(
  layer: number,
  min: [number, number, number],
  max: [number, number, number],
  motion: CollisionBody['motion'] = 'fixed',
): CollisionData {
  const points: number[] = [];
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) points.push(x, y, z);
  }
  const body: CollisionBody = {
    node: 'Body',
    transform: IDENTITY,
    motion,
    phantom: false,
    layer,
    mass: motion === 'dynamic' ? 5 : 0,
    inertia: motion === 'dynamic' ? [0.1, 0.1, 0.1] : [0, 0, 0],
    centerOfMass: [0, 0, 0],
    friction: 0.5,
    restitution: 0.4,
    linearDamping: 0,
    angularDamping: 0,
    gravityFactor: 1,
    maxLinearVelocity: 100,
    maxAngularVelocity: 30,
    quality: 0,
    solverDeactivation: 1,
    shapes: [{ type: 'convex', layer, material: 0, points: Float32Array.from(points), radius: 0 }],
  };
  return { bodies: [body], skipped: [] };
}

const settings = {
  maxSlope: 60,
  fallingGravity: 1,
  unsupportedGravity: 1,
  stairMaterials: new Set<number>(),
  stairHeight: 32,
};

beforeAll(async () => {
  await initPhysics();
});

describe('the physics step', () => {
  it('steps without wrapping every body again (no soft bodies), as World.step steps', () => {
    const run = (step: (world: RAPIER.World) => void): RAPIER.Vector => {
      const physics = new PhysicsWorld(matrix, GRAVITY);
      physics.addObject(box(Layer.static, [-500, -500, -20], [500, 500, 0]), IDENTITY, {
        reference: 1,
        kind: 'object',
      });
      const falling = physics.addObject(
        box(Layer.clutter, [-5, -5, 40], [5, 5, 50], 'dynamic'),
        IDENTITY,
        { reference: 2, kind: 'object' },
      );
      for (let i = 0; i < 90; i++) step(physics.world);
      const at = falling.bodies[0]?.body.translation() ?? { x: NaN, y: NaN, z: NaN };
      physics.free();
      return at;
    };
    const stepped = run((world) => {
      world.step();
    });
    const walk = vi.fn();
    const quick = run((world) => {
      world.mapNewSoftBodies = walk;
      stepWorld(world, undefined, undefined);
    });
    expect(walk).not.toHaveBeenCalled();
    expect(quick).toEqual(stepped);
  });

  it("PhysicsWorld.step leaves out World.step's walk over the bodies", () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    physics.addObject(box(Layer.static, [-50, -50, -20], [50, 50, 0]), IDENTITY, {
      reference: 1,
      kind: 'object',
    });
    const walk = vi.spyOn(physics.world, 'mapNewSoftBodies');
    expect(physics.step(3 / 60)).toBe(3);
    expect(walk).not.toHaveBeenCalled();
    physics.free();
  });

  it('looks for the awake among the bodies that can be simulated, not every body', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    physics.addObject(box(Layer.static, [-500, -500, -20], [500, 500, 0]), IDENTITY, {
      reference: 1,
      kind: 'object',
    });
    const falling = physics.addObject(
      box(Layer.clutter, [-5, -5, 40], [5, 5, 50], 'dynamic'),
      IDENTITY,
      { reference: 2, kind: 'object' },
    );
    // Held where it was placed (not settling): simulated only once something touches it.
    const held = physics.addObject(
      box(Layer.clutter, [100, -5, 0], [110, 5, 10], 'dynamic'),
      IDENTITY,
      { reference: 3, kind: 'object' },
      false,
    );
    // A body made outside addObject, simulated as its collider is registered.
    const raw = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(3, 0, 2).setGravityScale(0),
    );
    physics.register(physics.world.createCollider(RAPIER.ColliderDesc.ball(0.1), raw), 5, {
      reference: 4,
      kind: 'object',
    });
    const awake = (): number[] => {
      const handles: number[] = [];
      physics.forEachAwake((body) => handles.push(body.handle));
      return handles.sort((a, b) => a - b);
    };
    const fallingBody = falling.bodies[0]?.body;
    const heldBody = held.bodies[0]?.body;
    if (!fallingBody || !heldBody) throw new Error('bodies');
    expect(awake()).toEqual([fallingBody.handle, raw.handle].sort((a, b) => a - b));
    // The step's own passes (the speeds before it, the top speeds, the deactivation, the
    // bounds) and the water's walk no whole world.
    const walk = vi.spyOn(physics.world.bodies, 'forEach');
    const water = new WaterPhysics(physics, () => undefined);
    for (let i = 0; i < 30; i++) {
      physics.step(1 / 60, (seconds) => {
        water.step(seconds);
      });
    }
    expect(walk).not.toHaveBeenCalled();
    // The speed it had before the step is known all the same (velocityBefore).
    raw.setLinvel({ x: 1, y: 0, z: 0 }, true);
    physics.step(1 / 60);
    expect(physics.velocityBefore(raw).x).toBeCloseTo(1, 5);
    // Released, the held one is among them; removed, a body is not.
    physics.release(heldBody);
    expect(awake()).toContain(heldBody.handle);
    physics.remove(held);
    physics.world.removeRigidBody(raw);
    expect(awake()).toEqual(fallingBody.isSleeping() ? [] : [fallingBody.handle]);
    physics.free();
  });

  it("passes over the half of a welded mesh a body does not meet inside Rapier's groups", () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    // A welded floor (Havok's one-sided welding): its two-sided original and its one-sided copy.
    const floor = box(Layer.static, [-500, -500, -20], [500, 500, 0]);
    const [base] = floor.bodies;
    if (!base) throw new Error('a body');
    const placed = physics.addObject(
      {
        bodies: [
          {
            ...base,
            shapes: [
              {
                type: 'mesh',
                layer: Layer.static,
                material: 0,
                vertices: Float32Array.from([
                  -500, -500, 0, 500, -500, 0, 500, 500, 0, -500, 500, 0,
                ]),
                indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
                oneSided: true,
              },
            ],
          },
        ],
        skipped: [],
      },
      IDENTITY,
      { reference: 1, kind: 'object' },
    );
    const [twoSided, faces] = placed.colliders;
    if (!twoSided || !faces) throw new Error('two colliders');
    const filter = (collider: RAPIER.Collider): number => collider.collisionGroups() & 0xffff;
    const member = (collider: RAPIER.Collider): number => collider.collisionGroups() >>> 16;
    // Loose clutter and a ragdoll's body lying on it.
    const clutter = physics.addObject(
      box(Layer.clutter, [-5, -5, 1], [5, 5, 11], 'dynamic'),
      IDENTITY,
      { reference: 2, kind: 'object' },
    );
    const limb = physics.addObject(
      box(Layer.biped, [95, -5, 1], [105, 5, 11], 'dynamic'),
      IDENTITY,
      { reference: 3, kind: 'actor' },
    );
    const [loose] = clutter.colliders;
    const [bone] = limb.colliders;
    if (!loose || !bone) throw new Error('colliders');
    // Each half's filter takes the bodies it meets, and no other's.
    expect(filter(twoSided) & member(loose)).not.toBe(0);
    expect(filter(twoSided) & member(bone)).toBe(0);
    expect(filter(faces) & member(bone)).not.toBe(0);
    expect(filter(faces) & member(loose)).toBe(0);
    // The contact filter is asked once a step for each body on the floor (the half it meets),
    // not twice.
    const pipeline = physics.world.physicsPipeline;
    const step = pipeline.step.bind(pipeline);
    let asked = 0;
    vi.spyOn(pipeline, 'step').mockImplementation((...args) => {
      const hooks = args[12];
      const counted: RAPIER.PhysicsHooks | undefined = hooks && {
        filterContactPair: (...pair) => {
          asked++;
          return hooks.filterContactPair(...pair);
        },
        filterIntersectionPair: (...pair) => hooks.filterIntersectionPair(...pair),
      };
      args[12] = counted;
      step(...args);
    });
    // (While both are at the floor, moving: a pair is looked at again as its body moves.)
    for (let i = 0; i < 10; i++) physics.step(1 / 60);
    expect(asked).toBe(20);
    // The clutter lies on the floor all the same.
    const height = (clutter.bodies[0]?.body.translation().z ?? NaN) * 69.99125;
    for (let i = 0; i < 60; i++) physics.step(1 / 60);
    expect(height).toBeGreaterThan(-2);
    expect(height).toBeLessThan(1);
    expect((clutter.bodies[0]?.body.translation().z ?? NaN) * 69.99125).toBeCloseTo(height, 1);
    physics.free();
  });

  it('keeps pairs of handles in either order', () => {
    const pairs = new HandlePairs();
    pairs.add(3, 7);
    pairs.add(7, 3);
    pairs.add(3, 9);
    expect(pairs.size).toBe(2);
    expect(pairs.has(7, 3)).toBe(true);
    expect(pairs.has(3, 7)).toBe(true);
    expect(pairs.has(9, 7)).toBe(false);
    pairs.delete(7, 3);
    expect(pairs.has(3, 7)).toBe(false);
    expect(pairs.has(9, 3)).toBe(true);
    expect(pairs.size).toBe(1);
  });
});

describe("the controllers' query groups", () => {
  it('take exactly the colliders the controller filter takes', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const filter = physics.filterFor(Layer.charController);
    const placed = [Layer.static, Layer.biped, Layer.bipedNoCc, Layer.clutter].map((layer, i) =>
      physics.addObject(box(layer, [i * 100, 0, 0], [i * 100 + 10, 10, 10]), IDENTITY, {
        reference: 10 + i,
        kind: 'object',
      }),
    );
    for (const { colliders } of placed) {
      for (const collider of colliders) {
        const member = ((collider.collisionGroups() >>> 16) & QueryGroups.controllerSolid) !== 0;
        expect(member).toBe(filter(collider));
      }
    }
    // A death moves the bodies to a layer the controllers do not meet: out of the group.
    const ragdoll = physics.addObject(
      box(Layer.bipedNoCc, [0, 300, 0], [10, 310, 10], 'dynamic'),
      IDENTITY,
      { reference: 20, kind: 'actor' },
    );
    expect(physics.controllerSolidOf(20)).toBe(1);
    physics.setLayer(ragdoll, Layer.biped);
    const [collider] = ragdoll.colliders;
    if (!collider) throw new Error('a collider');
    expect(((collider.collisionGroups() >>> 16) & QueryGroups.controllerSolid) !== 0).toBe(false);
    expect(physics.controllerSolidOf(20)).toBe(0);
    physics.free();
  });

  it("counts an actor's colliders a controller meets, its own controller left out", () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const character = new CharacterBody(physics, { radius: 14, height: 128 }, settings, [0, 0, 0], {
      reference: 0x14,
      kind: 'actor',
    });
    expect(physics.controllerSolidOf(0x14)).toBe(1);
    expect(physics.controllerSolidOf(0x14, character.collider)).toBe(0);
    const own = physics.addObject(box(Layer.bipedNoCc, [100, 0, 0], [110, 10, 10]), IDENTITY, {
      reference: 0x14,
      kind: 'actor',
    });
    expect(physics.controllerSolidOf(0x14, character.collider)).toBe(1);
    physics.remove(own);
    expect(physics.controllerSolidOf(0x14, character.collider)).toBe(0);
    physics.free();
  });

  it("leaves a phantom out of what a controller meets: its skeleton's CharacterBumper", () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const character = new CharacterBody(physics, { radius: 14, height: 128 }, settings, [0, 0, 0], {
      reference: 0x14,
      kind: 'actor',
    });
    // The bumper of every humanoid skeleton: a fixed phantom capsule on L_CHARCONTROLLER.
    const bumper = box(Layer.charController, [-20, -20, 0], [20, 20, 120]);
    const [body] = bumper.bodies;
    if (!body) throw new Error('a body');
    const placed = physics.addObject(
      { bodies: [{ ...body, phantom: true }], skipped: [] },
      IDENTITY,
      { reference: 0x14, kind: 'actor' },
    );
    const [collider] = placed.colliders;
    if (!collider) throw new Error('a collider');
    expect(collider.isSensor()).toBe(true);
    expect(((collider.collisionGroups() >>> 16) & QueryGroups.controllerSolid) !== 0).toBe(false);
    // Nothing of its own that its sweeps would have to be told about.
    expect(physics.controllerSolidOf(0x14, character.collider)).toBe(0);
    physics.free();
  });

  it('keeps what no actor owns in the ground group, and actors’ shapes out of it', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const ground = (collider: RAPIER.Collider | undefined): boolean =>
      collider !== undefined &&
      ((collider.collisionGroups() >>> 16) & QueryGroups.controllerGround) !== 0;
    const floor = physics.addObject(box(Layer.static, [-50, -50, -20], [50, 50, 0]), IDENTITY, {
      reference: 1,
      kind: 'object',
    });
    const others = physics.addObject(box(Layer.bipedNoCc, [60, 0, 0], [70, 10, 10]), IDENTITY, {
      reference: 0x99,
      kind: 'actor',
    });
    const unmet = physics.addObject(box(Layer.biped, [80, 0, 0], [90, 10, 10]), IDENTITY, {
      reference: 2,
      kind: 'object',
    });
    const character = new CharacterBody(physics, { radius: 14, height: 128 }, settings, [0, 0, 0], {
      reference: 0x14,
      kind: 'actor',
    });
    expect(ground(floor.colliders[0])).toBe(true);
    expect(ground(others.colliders[0])).toBe(false);
    expect(ground(unmet.colliders[0])).toBe(false);
    expect(ground(character.collider)).toBe(false);
    physics.free();
  });

  it('a controller standing among its own bodies asks the layers of nothing as it steps', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    physics.addObject(box(Layer.static, [-500, -500, -20], [500, 500, 0]), IDENTITY, {
      reference: 1,
      kind: 'object',
    });
    // A wall beside it, within its casts' reach.
    physics.addObject(box(Layer.static, [20, -100, 0], [30, 100, 200]), IDENTITY, {
      reference: 2,
      kind: 'object',
    });
    // Its own keyframed bodies through its shape (its ragdoll's, on L_BIPED) and its bumper.
    const own = { reference: 0x14, kind: 'actor' } as const;
    for (const z of [10, 40, 70, 100]) {
      const bone = physics.addObject(
        box(Layer.biped, [-8, -8, z], [8, 8, z + 20], 'dynamic'),
        IDENTITY,
        own,
        false,
      );
      physics.keyframe(bone);
    }
    const [bumper] = box(Layer.charController, [-20, -20, 0], [20, 20, 120]).bodies;
    if (!bumper) throw new Error('a body');
    physics.addObject({ bodies: [{ ...bumper, phantom: true }], skipped: [] }, IDENTITY, own);
    const character = new CharacterBody(
      physics,
      { radius: 14, height: 128 },
      settings,
      [0, 0, 0],
      own,
    );
    const step = (): void => {
      physics.step(1 / 60, (seconds) => {
        character.step(seconds);
      });
    };
    for (let i = 0; i < 30; i++) step();
    expect(character.grounded).toBe(true);
    expect(Math.abs(character.feet[2])).toBeLessThan(2);
    // Standing, then walking along the wall: Rapier's groups tell what it meets; the layers'
    // table is asked for no collider (each asking is a call back from inside a sweep or a cast).
    const asked = vi.spyOn(physics.matrix, 'collides');
    for (let i = 0; i < 10; i++) step();
    character.velocity = [0, 120];
    for (let i = 0; i < 30; i++) step();
    expect(asked).not.toHaveBeenCalled();
    asked.mockRestore();
    expect(character.grounded).toBe(true);
    expect(character.feet[1]).toBeGreaterThan(50);
    expect(Math.abs(character.feet[0])).toBeLessThan(2);
    physics.free();
  });

  it("walks through a body of its own a controller meets, and stops at another actor's", () => {
    const walk = (owner: number): number => {
      const physics = new PhysicsWorld(matrix, GRAVITY);
      physics.addObject(box(Layer.static, [-500, -500, -20], [500, 500, 0]), IDENTITY, {
        reference: 1,
        kind: 'object',
      });
      // A body on BIPED_NO_CC across the way, 60 units ahead.
      physics.addObject(box(Layer.bipedNoCc, [60, -100, 0], [70, 100, 200]), IDENTITY, {
        reference: owner,
        kind: 'actor',
      });
      const character = new CharacterBody(
        physics,
        { radius: 14, height: 128 },
        settings,
        [0, 0, 0],
        { reference: 0x14, kind: 'actor' },
      );
      physics.step(1 / 60);
      character.velocity = [200, 0];
      for (let i = 0; i < 60; i++)
        physics.step(1 / 60, (step) => {
          character.step(step);
        });
      const x = character.feet[0];
      physics.free();
      return x;
    };
    expect(walk(0x14)).toBeGreaterThan(150);
    expect(walk(0x99)).toBeLessThan(60);
  });
});
