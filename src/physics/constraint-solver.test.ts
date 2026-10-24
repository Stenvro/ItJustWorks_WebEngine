import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  easedLimit,
  gravityShare,
  slowBodyFactor,
  solveJoints,
  solverSettings,
  SOLVER_DEFAULTS,
  type SolverJoint,
} from './constraint-solver.ts';
import { initPhysics } from './physics-world.ts';

beforeAll(async () => {
  await initPhysics();
});

/**
 * A 1 kg rod 1 m long hanging from a fixed point by a ragdoll joint, held out level: its weight
 * pulls with 4.9 N·m about the joint. Returns how far it has turned down after `seconds`.
 */
function rod(friction: number, substeps: number, seconds: number): number {
  const world = new RAPIER.World({ x: 0, y: 0, z: -9.8 });
  world.timestep = 1 / 60;
  world.integrationParameters.numSolverIterations = substeps;
  const anchor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const bob = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(0.5, 0, 0).setCanSleep(false),
  );
  world.createCollider(
    RAPIER.ColliderDesc.capsule(0.5, 0.02)
      .setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 })
      .setMass(1),
    bob,
  );
  world.createImpulseJoint(
    RAPIER.JointData.spherical({ x: 0, y: 0, z: 0 }, { x: -0.5, y: 0, z: 0 }),
    anchor,
    bob,
    true,
  );
  const joint: SolverJoint = {
    a: anchor,
    b: bob,
    constraint: {
      type: 'ragdoll',
      a: {
        pivot: [0, 0, 0],
        axes: [
          [1, 0, 0],
          [0, 1, 0],
        ],
      },
      b: {
        pivot: [-0.5, 0, 0],
        axes: [
          [1, 0, 0],
          [0, 1, 0],
        ],
      },
      maxFriction: friction,
    },
  };
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    solveJoints([joint], 1 / 60, world.gravity, substeps);
    world.step();
  }
  const p = bob.translation();
  const down = (Math.atan2(-p.z, p.x) * 180) / Math.PI;
  world.free();
  return down;
}

describe('the constraint solver', () => {
  it("holds a limb by its joint's friction against a lesser weight, as Havok's friction does", () => {
    // 6 N·m of friction against 4.9 of weight: it stays (a creep of a few tenths of a degree).
    expect(rod(6, 8, 2)).toBeLessThan(1);
    expect(rod(6, 1, 2)).toBeLessThan(1);
  });

  it('lets a limb go when its weight is the greater', () => {
    expect(rod(3, 8, 2)).toBeGreaterThan(60);
  });

  it('eases a limit the joint lies past by tau of the way a step, and leaves a small excess', () => {
    const tau = SOLVER_DEFAULTS.tau * 0.8;
    const [lo, hi] = easedLimit(-1, -0.2, 0.5, tau) ?? [0, 0];
    expect(lo).toBeCloseTo(-1 + tau * 0.8);
    expect(hi).toBe(0.5);
    expect(easedLimit(0.52, -0.2, 0.5, tau)).toBeUndefined();
    expect(easedLimit(0, -0.2, 0.5, tau)).toBeUndefined();
  });

  it("takes the engine's solver settings at its step", () => {
    expect(solverSettings(1 / 60, 1 / 60, 0.5)).toEqual({ tau: 0.6, damping: 1, iterations: 4 });
    // A step half the engine's: tau and the iterations fall with it.
    const half = solverSettings(1 / 120, 1 / 60, 0.5);
    expect(half.tau).toBeCloseTo(0.45);
    expect(half.iterations).toBe(2);
  });

  it("solves with the share of gravity Rapier's substeps give", () => {
    expect(gravityShare(1)).toBe(1);
    expect(gravityShare(8)).toBeCloseTo(9 / 16);
  });

  it('slows slow bodies of the low class and above (Havok’s solver deactivation)', () => {
    const g = 9.8;
    expect(slowBodyFactor(1, g, 0.01, 0, 4)).toBe(1);
    expect(slowBodyFactor(2, g, 1, 0, 4)).toBe(1);
    const low = slowBodyFactor(2, g, 0.05, 0.01, 4);
    expect(low).toBeGreaterThan(0.85);
    expect(low).toBeLessThan(0.9);
    expect(slowBodyFactor(5, g, 0.05, 0.01, 4)).toBeLessThan(low);
  });
});
