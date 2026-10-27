import { beforeAll, describe, expect, it } from 'vitest';
import type { Mat4 } from '../render/math.ts';
import { HAVOK_SCALE, type CollisionBody, type CollisionData } from './collision-data.ts';
import { CollisionMatrix, Layer } from './collision-layers.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from './physics-world.ts';
import {
  buoyancyForce,
  floatingShare,
  splashSize,
  submergedShare,
  waterAcceleration,
  WATER_DENSITY,
  WATER_RULE_DEFAULTS,
  WaterPhysics,
  type WaterRules,
} from './water-physics.ts';

describe('buoyancy', () => {
  it('lifts by the water displaced, as the material floats', () => {
    // A cubic metre wholly under: a neutral material (0) is lifted by its own volume of water,
    // a floating one (1) by twice that, stone (−1) not at all.
    const base = { volume: 1, submerged: 1, gravity: 9.8 };
    expect(buoyancyForce({ ...base, buoyancy: 0 })).toBeCloseTo(WATER_DENSITY * 9.8);
    expect(buoyancyForce({ ...base, buoyancy: 1 })).toBeCloseTo(2 * WATER_DENSITY * 9.8);
    expect(buoyancyForce({ ...base, buoyancy: -1 })).toBe(0);
    expect(buoyancyForce({ ...base, buoyancy: 0.25, submerged: 0.5 })).toBeCloseTo(
      1.25 * 0.5 * WATER_DENSITY * 9.8,
    );
  });

  it('floats light bodies where lift meets weight, and sinks the heavy', () => {
    // A 300 kg wooden crate of a cubic metre floats 24 % under; an iron one does not float.
    expect(floatingShare({ mass: 300, volume: 1, buoyancy: 0.25 })).toBeCloseTo(0.24);
    expect(floatingShare({ mass: 300, volume: 1, buoyancy: -1 })).toBeUndefined();
    // A sword of 10 kg in 3 litres sinks even of a neutral material.
    expect(floatingShare({ mass: 10, volume: 0.003, buoyancy: 0 })).toBeUndefined();
  });

  it('measures how much of a body lies under the surface', () => {
    expect(submergedShare(0, 1, 0)).toBeCloseTo(0.5);
    expect(submergedShare(2, 1, 0)).toBe(0);
    expect(submergedShare(-2, 1, 0)).toBe(1);
  });
});

describe('current', () => {
  it('drags a body towards the water velocity', () => {
    const a = waterAcceleration({
      mass: 10,
      volume: 0,
      buoyancy: 0,
      submerged: 1,
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 1],
      current: [2.54, 1.35, 0],
      angularCurrent: [0, 0, 0],
      gravity: 9.8,
    });
    expect(a.linear[0]).toBeGreaterThan(0);
    expect(a.linear[1]).toBeGreaterThan(0);
    expect(a.linear[0] / a.linear[1]).toBeCloseTo(2.54 / 1.35);
    // The spin is slowed.
    expect(a.angular[2]).toBeLessThan(0);
    // Moving with the water, nothing drags.
    const moving = {
      mass: 10,
      volume: 0,
      buoyancy: 0,
      submerged: 1,
      velocity: [2.54, 1.35, 0] as [number, number, number],
      angularVelocity: [0, 0, 0] as [number, number, number],
      current: [2.54, 1.35, 0] as [number, number, number],
      angularCurrent: [0, 0, 0] as [number, number, number],
      gravity: 9.8,
    };
    expect(waterAcceleration(moving).linear[0]).toBeCloseTo(0);
    // Out of the water, nothing at all.
    expect(waterAcceleration({ ...moving, velocity: [0, 0, 0], submerged: 0 }).linear).toEqual([
      0, 0, 0,
    ]);
  });
});

describe('splashes', () => {
  it('sizes a splash by speed', () => {
    expect(splashSize(50, false)).toBeUndefined();
    expect(splashSize(200, false)).toBe('light');
    expect(splashSize(600, false)).toBe('medium');
    expect(splashSize(1200, false)).toBe('heavy');
    // Leaving the water splashes half as much.
    expect(splashSize(600, true)).toBe('light');
  });
});

const IDENTITY: Mat4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const WOOD = 11;
const STONE = 12;
const RIVER = 0x108ac7;
const matrix = new CollisionMatrix([
  { formId: 1, editorId: 'L_CLUTTER', index: Layer.clutter, name: '', flags: 0, collidesWith: [] },
]);

/** A dynamic cube of a material, `size` game units wide, at `z`. */
function crate(material: number, mass: number, size: number): CollisionData {
  const h = size / 2;
  const points: number[] = [];
  for (const x of [-h, h]) for (const y of [-h, h]) for (const z of [-h, h]) points.push(x, y, z);
  const body: CollisionBody = {
    node: 'Crate',
    transform: IDENTITY,
    motion: 'dynamic',
    phantom: false,
    layer: Layer.clutter,
    mass,
    inertia: [mass / 6, mass / 6, mass / 6],
    centerOfMass: [0, 0, 0],
    friction: 0.5,
    restitution: 0.2,
    linearDamping: 0,
    angularDamping: 0.05,
    gravityFactor: 1,
    maxLinearVelocity: 0,
    maxAngularVelocity: 0,
    quality: 0,
    solverDeactivation: 1,
    shapes: [
      {
        type: 'convex',
        layer: Layer.clutter,
        material,
        points: Float32Array.from(points),
        radius: 0,
      },
    ],
  };
  return { bodies: [body], skipped: [] };
}

describe('water physics', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  const rules: WaterRules = {
    ...WATER_RULE_DEFAULTS,
    currents: new Map([[RIVER, { linear: [1.8, -2.2, 0], angular: [0, 0, 0] }]]),
    buoyancy: new Map([
      [WOOD, 0.25],
      [STONE, -1],
    ]),
  };

  function run(material: number, seconds: number) {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    // A river 1000 units deep, its surface at 0.
    const water = new WaterPhysics(
      physics,
      (_x, _y, z) => (z > -1000 ? { height: 0, type: RIVER } : undefined),
      rules,
    );
    const at = new Float32Array(IDENTITY);
    at[14] = 200;
    const placed = physics.addObject(crate(material, 300, HAVOK_SCALE), at, {
      reference: 1,
      kind: 'object',
    });
    for (let t = 0; t < seconds; t += physics.stepSeconds) {
      physics.step(physics.stepSeconds, (step) => {
        water.step(step);
      });
    }
    const body = placed.bodies[0]?.body;
    if (!body) throw new Error('no body');
    const p = body.translation();
    const v = body.linvel();
    return { water, z: p.z * HAVOK_SCALE, x: p.x * HAVOK_SCALE, velocity: v };
  }

  it('floats a dropped wooden crate at the surface and carries it downstream', () => {
    const { water, z, x, velocity } = run(WOOD, 30);
    // A cubic metre of 300 kg wood floats 24 % under: its middle 0.26 m (18 units) above.
    expect(z).toBeGreaterThan(8);
    expect(z).toBeLessThan(28);
    expect(Math.abs(velocity.z)).toBeLessThan(0.2);
    // It drifts with the river (1.8, −2.2 m/s).
    expect(velocity.x).toBeCloseTo(1.8, 0);
    expect(velocity.y).toBeCloseTo(-2.2, 0);
    expect(x).toBeGreaterThan(1000);
    // It splashed as it fell in (from 200 units: a light splash).
    expect(water.drainSplashes().some((splash) => !splash.leaving)).toBe(true);
  });

  it('sinks a stone one', () => {
    const { z, velocity } = run(STONE, 2);
    expect(z).toBeLessThan(-200);
    // Slowed by the water: well under the speed of a free fall.
    expect(velocity.z).toBeGreaterThan(-9);
  });
});
