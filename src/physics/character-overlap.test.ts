import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../render/math.ts';
import {
  CharacterBody,
  CONTROLLER_SHELL,
  PENETRATION_RECOVERY,
  recoveringVelocity,
  wayOut,
} from './character.ts';
import { HAVOK_SCALE } from './collision-data.ts';
import { CollisionMatrix, Layer } from './collision-layers.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from './physics-world.ts';

/** Static and the character controller collide, and controllers with one another. */
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

const SETTINGS = {
  maxSlope: 60,
  fallingGravity: 1,
  unsupportedGravity: 1,
  stairMaterials: new Set<number>(),
  stairHeight: 32,
};
const SHAPE = { radius: 14.42, height: 131.84 };
const STEP = 1 / 60;
const h = (v: number): number => v / HAVOK_SCALE;
/**
 * The most a controller set into others moves in a step (units): out at the recovery speed, then
 * out of the last of the overlap (shallower than the depth recovery takes) by the sweep at once.
 * (Pushed out by the whole depth in every step, two on one spot moved some 30 units a step.)
 */
const SETTLE = 3;
const across = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

beforeAll(async () => {
  await initPhysics();
});

/** A world with a 2,000 × 2,000 floor, its top at z 0. */
function floor(): PhysicsWorld {
  const physics = new PhysicsWorld(matrix, GRAVITY);
  const body = physics.world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, h(-10)),
  );
  const collider = physics.world.createCollider(
    RAPIER.ColliderDesc.cuboid(h(1000), h(1000), h(10)),
    body,
  );
  physics.register(collider, Layer.static, { reference: 1, kind: 'object' });
  physics.step(STEP);
  return physics;
}

/** An NPC's controller (as the stage makes one) with its feet at `feet`. */
function actor(physics: PhysicsWorld, reference: number, feet: Vec3): CharacterBody {
  const character = new CharacterBody(physics, SHAPE, SETTINGS, feet, {
    reference,
    kind: 'actor',
  });
  character.seeksAround = true;
  character.standsOnActors = false;
  return character;
}

/** Every character steps, then the world; the largest distance one moved in a step (across). */
function run(physics: PhysicsWorld, characters: readonly CharacterBody[], steps: number): number {
  let fastest = 0;
  for (let i = 0; i < steps; i++) {
    const before = characters.map((character) => [...character.feet] as Vec3);
    for (const character of characters) character.step(STEP);
    physics.step(STEP);
    characters.forEach((character, k) => {
      const from = before[k];
      if (from) fastest = Math.max(fastest, across(from, character.feet));
    });
  }
  return fastest;
}

describe('the way out of another controller', () => {
  it('is away from its centre', () => {
    const way = wayOut({ x: 1, y: 0 }, { x: 0, y: 0 }, 0x20, 0x10);
    expect(way[0]).toBeCloseTo(1);
    expect(way[1]).toBeCloseTo(0);
  });

  it('is opposite for two on one spot, by their references, a way of their own per pair', () => {
    const spot = { x: 3, y: 4 };
    const a = wayOut(spot, spot, 0x886b3, 0x886b4);
    const b = wayOut(spot, spot, 0x886b4, 0x886b3);
    expect(Math.hypot(a[0], a[1])).toBeCloseTo(1);
    expect(a[0] + b[0]).toBeCloseTo(0);
    expect(a[1] + b[1]).toBeCloseTo(0);
    const c = wayOut(spot, spot, 0x886b3, 0x886b5);
    expect(Math.abs(a[0] * c[0] + a[1] * c[1])).toBeLessThan(0.999);
  });
});

describe('penetration recovery (the character proxy solving against the planes it is in)', () => {
  const inside = [{ way: [1, 0] as const, depth: 30 }];

  it('leaves at the depth times the recovery speed, not at once', () => {
    expect(recoveringVelocity([0, 0], inside)).toEqual([30 * PENETRATION_RECOVERY, 0]);
  });

  it('walks off freely and never further in', () => {
    expect(recoveringVelocity([90, 20], inside)).toEqual([90, 20]);
    expect(recoveringVelocity([-90, 20], inside)).toEqual([30, 20]);
    expect(recoveringVelocity([0, -80], inside)).toEqual([30, -80]);
  });
});

describe('controllers set into one another', () => {
  it('part in opposite directions, slowly, two set on one spot', () => {
    const physics = floor();
    const spot: Vec3 = [0, 0, 1];
    const a = actor(physics, 0x886b3, spot);
    const b = actor(physics, 0x886b4, spot);
    // Half a second: apart, each its own way (the middle between them stays), never flung.
    const fastest = run(physics, [a, b], 30);
    expect(across(a.feet, b.feet)).toBeGreaterThan(5);
    const middle: Vec3 = [(a.feet[0] + b.feet[0]) / 2, (a.feet[1] + b.feet[1]) / 2, 0];
    expect(across(middle, spot)).toBeLessThan(1);
    // At most the whole width a second (the depth times the recovery speed).
    const width = 2 * (SHAPE.radius + CONTROLLER_SHELL);
    expect(fastest).toBeLessThanOrEqual(width * PENETRATION_RECOVERY * STEP + 0.01);
    expect(run(physics, [a, b], 150)).toBeLessThan(SETTLE);
    // In three seconds out of each other, on the floor where they were.
    expect(across(a.feet, b.feet)).toBeGreaterThan(width - 2);
    expect(across(middle, spot)).toBeLessThan(1);
    expect(Math.abs(a.feet[2] - spot[2])).toBeLessThan(2);
    expect(a.grounded && b.grounded).toBe(true);
  });

  it('part, three set on one spot', () => {
    const physics = floor();
    const spot: Vec3 = [0, 0, 1];
    const all = [0x886b3, 0x886b4, 0x886b5].map((reference) => actor(physics, reference, spot));
    const fastest = run(physics, all, 240);
    const width = 2 * (SHAPE.radius + CONTROLLER_SHELL);
    expect(fastest).toBeLessThan(SETTLE);
    for (let i = 0; i < all.length; i++) {
      for (let k = i + 1; k < all.length; k++) {
        const one = all[i];
        const other = all[k];
        if (one && other) expect(across(one.feet, other.feet)).toBeGreaterThan(width / 2);
      }
    }
  });

  it('lets one walk off the other at its own speed', () => {
    const physics = floor();
    const a = actor(physics, 0x30, [0, 0, 1]);
    const b = actor(physics, 0x31, [10, 0, 1]);
    run(physics, [a, b], 10);
    const from = [...a.feet] as Vec3;
    a.velocity = [-120, 0];
    run(physics, [a, b], 30);
    // Half a second at 120 units a second (and its way out of b besides).
    expect(from[0] - a.feet[0]).toBeGreaterThan(55);
  });
});
