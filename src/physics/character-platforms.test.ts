import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../render/math.ts';
import { CharacterBody, pushedSpeed } from './character.ts';
import { HAVOK_SCALE } from './collision-data.ts';
import { CollisionMatrix, Layer } from './collision-layers.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from './physics-world.ts';

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

const SETTINGS = {
  maxSlope: 60,
  fallingGravity: 1,
  unsupportedGravity: 1,
  stairMaterials: new Set<number>(),
  stairHeight: 32,
};

const ACTOR = { reference: 0x14, kind: 'actor' } as const;
const h = (v: number): number => v / HAVOK_SCALE;

beforeAll(async () => {
  await initPhysics();
});

/** A 600 × 600 × 20 platform (game units), its top at z 0. */
function platform(physics: PhysicsWorld, kind: 'kinematic' | 'fixed'): RAPIER.RigidBody {
  const desc =
    kind === 'kinematic'
      ? RAPIER.RigidBodyDesc.kinematicPositionBased()
      : RAPIER.RigidBodyDesc.fixed();
  const made = physics.world.createRigidBody(desc.setTranslation(0, 0, h(-10)));
  const collider = physics.world.createCollider(
    RAPIER.ColliderDesc.cuboid(h(300), h(300), h(10)),
    made,
  );
  physics.register(collider, Layer.static, { reference: 1, kind: 'object' });
  return made;
}

/** A character standing (grounded) with its feet at `feet`. */
function settled(physics: PhysicsWorld, feet: Vec3): CharacterBody {
  const character = new CharacterBody(
    physics,
    { radius: 14.42, height: 131.84 },
    SETTINGS,
    feet,
    ACTOR,
  );
  for (let i = 0; i < 10; i++) {
    character.step(1 / 60);
    physics.step(1 / 60);
  }
  expect(character.grounded).toBe(true);
  return character;
}

describe('moving bodies carry the character controller', () => {
  for (const how of ['by its keyframes', 'by a script (set at once)'] as const) {
    it(`carries a character on a lift moving ${how}`, () => {
      const physics = new PhysicsWorld(matrix, GRAVITY);
      const lift = platform(physics, 'kinematic');
      physics.step(1 / 60);
      const character = settled(physics, [0, 0, 1]);
      const start = character.feet;
      // One second: 120 units along +x and 60 up.
      for (let i = 1; i <= 60; i++) {
        const at = { x: h(i * 2), y: 0, z: h(-10 + i) };
        if (how === 'by its keyframes') lift.setNextKinematicTranslation(at);
        else lift.setTranslation(at, true);
        character.step(1 / 60);
        physics.step(1 / 60);
      }
      const [x, y, z] = character.feet;
      expect(x - start[0]).toBeGreaterThan(118);
      expect(x - start[0]).toBeLessThan(122);
      expect(Math.abs(y - start[1])).toBeLessThan(1);
      expect(z - start[2]).toBeGreaterThan(58);
      expect(z - start[2]).toBeLessThan(62);
      expect(character.grounded).toBe(true);
      character.free();
      physics.free();
    });
  }

  it('carries a character round on a turning platform, and turns it', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const turntable = platform(physics, 'kinematic');
    physics.step(1 / 60);
    const character = settled(physics, [100, 0, 1]);
    // A quarter turn counter-clockwise (seen from above) in a second.
    let turned = 0;
    for (let i = 1; i <= 60; i++) {
      const angle = ((Math.PI / 2) * i) / 60;
      turntable.setNextKinematicRotation({
        x: 0,
        y: 0,
        z: Math.sin(angle / 2),
        w: Math.cos(angle / 2),
      });
      character.step(1 / 60);
      physics.step(1 / 60);
      turned += character.carriedTurn;
    }
    const [x, y] = character.feet;
    expect(Math.abs(x)).toBeLessThan(3);
    expect(y).toBeGreaterThan(97);
    expect(y).toBeLessThan(103);
    // The game's headings go clockwise: a quarter turn back.
    expect(turned).toBeCloseTo(-Math.PI / 2, 2);
    character.free();
    physics.free();
  });

  it('does not carry or turn a character on fixed ground', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    platform(physics, 'fixed');
    physics.step(1 / 60);
    const character = settled(physics, [0, 0, 1]);
    const start = character.feet;
    for (let i = 0; i < 30; i++) {
      character.step(1 / 60);
      physics.step(1 / 60);
      expect(character.carriedTurn).toBe(0);
    }
    expect(character.feet[0]).toBeCloseTo(start[0], 3);
    character.free();
    physics.free();
  });
});

describe('moving bodies push the character controller', () => {
  it('is knocked back by a heavy body that comes at it, hardly by a light one', () => {
    const run = (mass: number): number => {
      const physics = new PhysicsWorld(matrix, GRAVITY);
      platform(physics, 'fixed');
      physics.step(1 / 60);
      const character = settled(physics, [0, 0, 1]);
      // A 60-unit crate gliding at it along −x at 300 units a second.
      const crate = physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(h(90), 0, h(32)).setGravityScale(0),
      );
      const collider = physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(h(30), h(30), h(30)).setMass(mass).setFriction(0),
        crate,
      );
      physics.register(collider, Layer.static, { reference: 2, kind: 'object' });
      crate.setLinvel({ x: h(-300), y: 0, z: 0 }, true);
      for (let i = 0; i < 30; i++) {
        character.step(1 / 60);
        physics.step(1 / 60);
      }
      const x = character.feet[0];
      character.free();
      physics.free();
      return x;
    };
    expect(run(300)).toBeLessThan(-30);
    expect(run(1)).toBeGreaterThan(-8);
  });

  it('takes a share of the blow by the masses, never faster than the body, held to a cap', () => {
    expect(pushedSpeed(100, 100, 100)).toBeCloseTo(100);
    expect(pushedSpeed(100, 300, 100)).toBeCloseTo(100);
    expect(pushedSpeed(100, 10, 100)).toBeCloseTo((100 * 20) / 110);
    expect(pushedSpeed(-50, 300, 100)).toBe(0);
    expect(pushedSpeed(5000, 300, 100)).toBe(400);
  });
});
