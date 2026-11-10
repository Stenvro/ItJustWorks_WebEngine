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

describe('a simulated body under the character controller', () => {
  it('does not take the shape with it where the solver threw it (under the floor)', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    platform(physics, 'fixed');
    const crate = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0, h(30)).setGravityScale(0),
    );
    const collider = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(h(100), h(100), h(30)).setMass(5),
      crate,
    );
    physics.register(collider, Layer.static, { reference: 2, kind: 'object' });
    physics.step(1 / 60);
    const character = settled(physics, [0, 0, 61]);
    const start = character.feet;
    // The solver leaves it elsewhere than the step's forecast, turned and thrown.
    crate.setTranslation({ x: h(200), y: 0, z: h(-100) }, true);
    crate.setRotation({ x: 0.7071, y: 0, z: 0, w: 0.7071 }, true);
    character.step(1 / 60);
    physics.step(1 / 60);
    expect(Math.hypot(character.feet[0] - start[0], character.feet[1] - start[1])).toBeLessThan(10);
    expect(character.feet[2]).toBeGreaterThan(start[2] - 10);
    character.free();
    physics.free();
  });
});

describe('a simulated body the character stands on, by its mass', () => {
  /** How far a character standing on a 200 × 200 × 60 body of `mass` goes as it slides at `speed`. */
  const ride = (mass: number, speed: number): number => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    platform(physics, 'fixed');
    const crate = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0, h(30)).setGravityScale(0),
    );
    const collider = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(h(100), h(100), h(30)).setMass(mass).setFriction(0),
      crate,
    );
    physics.register(collider, Layer.static, { reference: 2, kind: 'object' });
    physics.step(1 / 60);
    const character = settled(physics, [0, 0, 61]);
    const start = character.feet;
    for (let i = 0; i < 30; i++) {
      crate.setLinvel({ x: h(speed), y: 0, z: 0 }, true);
      character.step(1 / 60);
      physics.step(1 / 60);
    }
    const gone = Math.hypot(character.feet[0] - start[0], character.feet[1] - start[1]);
    character.free();
    physics.free();
    return gone;
  };

  it('is not carried off by one light enough to push (under fMoveLimitMass) that the solver throws', () => {
    // A kettle thrown at 4000 units a second: half a second on it was 2000 units.
    expect(ride(1, 4000)).toBeLessThan(80);
  });

  it('is carried by a heavy one (fMoveLimitMass or more) as by a platform', () => {
    // 120 units a second for half a second.
    const gone = ride(300, 120);
    expect(gone).toBeGreaterThan(50);
    expect(gone).toBeLessThan(70);
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

describe('the jump and the step velocity', () => {
  it('keeps the velocity of the platform it jumps off until it lands', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const lift = platform(physics, 'kinematic');
    physics.step(1 / 60);
    const character = settled(physics, [0, 0, 1]);
    // The platform moves along x at 120 units a second, the character on it.
    const move = (seconds: number): void => {
      for (let i = 0; i < seconds * 60; i++) {
        const at = lift.translation();
        lift.setNextKinematicTranslation({ x: at.x + h(2), y: at.y, z: at.z });
        character.step(1 / 60);
        physics.step(1 / 60);
      }
    };
    move(0.5);
    expect(character.feet[0]).toBeGreaterThan(50);
    character.jump(200);
    move(1 / 60);
    const from = character.feet[0];
    move(0.2);
    expect(character.grounded).toBe(false);
    // In the air it goes on along x at the platform's speed, with nothing under it to carry it.
    expect((character.feet[0] - from) / 0.2).toBeGreaterThan(100);
    expect((character.feet[0] - from) / 0.2).toBeLessThan(140);
  });

  it('keeps nothing of a fixed floor it jumps off', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    platform(physics, 'fixed');
    physics.step(1 / 60);
    const character = settled(physics, [0, 0, 1]);
    character.jump(200);
    for (let i = 0; i < 12; i++) {
      character.step(1 / 60);
      physics.step(1 / 60);
    }
    expect(character.grounded).toBe(false);
    expect(Math.abs(character.feet[0])).toBeLessThan(0.01);
  });

  it('pushes off when asked even if a step left it off the ground (a stair’s edge)', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    platform(physics, 'fixed');
    physics.step(1 / 60);
    const character = settled(physics, [0, 0, 1]);
    // Off the ground for a step (as down a stair), then the jump's animation pushes off.
    character.teleport([0, 0, 200]);
    for (let i = 0; i < 3; i++) {
      character.step(1 / 60);
      physics.step(1 / 60);
    }
    expect(character.grounded).toBe(false);
    character.jump(300);
    character.step(1 / 60);
    physics.step(1 / 60);
    expect(character.verticalSpeed).toBeGreaterThan(250);
    // It goes up and comes down onto the platform again: a landing to tell its graph.
    let landed = false;
    for (let i = 0; i < 120 && !landed; i++) {
      character.step(1 / 60);
      physics.step(1 / 60);
      landed = character.grounded;
    }
    expect(landed).toBe(true);
  });

  it('is not put through a wall by a leaf that swings over it', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    platform(physics, 'fixed');
    // A thin wall just beside it, its face at x 18 (a shape of radius 14.42 stands at x 0).
    const wall = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(h(22), 0, h(100)),
    );
    physics.register(
      physics.world.createCollider(RAPIER.ColliderDesc.cuboid(h(4), h(200), h(100)), wall),
      Layer.static,
      { reference: 2, kind: 'object' },
    );
    // A leaf coming from the other side, far quicker than the shape is put out of it.
    const leaf = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(h(-40), 0, h(100)),
    );
    physics.register(
      physics.world.createCollider(RAPIER.ColliderDesc.cuboid(h(4), h(50), h(100)), leaf),
      Layer.static,
      { reference: 3, kind: 'object' },
    );
    physics.step(1 / 60);
    const character = settled(physics, [0, 0, 1]);
    for (let x = -40; x < 18; x += 8) {
      leaf.setNextKinematicTranslation({ x: h(x), y: 0, z: h(100) });
      character.step(1 / 60);
      physics.step(1 / 60);
      expect(character.feet[0] + 14.42).toBeLessThanOrEqual(18.5);
    }
  });

  it('measures its velocity over its last step, not over a frame', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    platform(physics, 'fixed');
    physics.step(1 / 60);
    const character = settled(physics, [0, 0, 1]);
    character.velocity = [120, 0];
    character.step(1 / 60);
    physics.step(1 / 60);
    // Read on any number of frames before the next step, it is the step's.
    expect(character.stepVelocity[0]).toBeCloseTo(120, 0);
    expect(character.stepVelocity[0]).toBeCloseTo(120, 0);
    expect(character.stepVelocity[1]).toBeCloseTo(0, 3);
  });
});
