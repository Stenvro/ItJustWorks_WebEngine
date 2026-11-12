import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  easedLimit,
  gravityShare,
  jointLimitGive,
  limitGive,
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

  it("gives a limit the stiffness the solver's iterations leave it, softest between light bodies", () => {
    // A human ankle (a limited hinge: tau factor 1): a 3 kg foot (0.012 kg·m² about the axle)
    // on a calf (0.12). Four iterations of tau 0.6 a step of 1/60 s: 4 × 0.6 × 3600 / (1/0.012
    // + 1/0.12) ≈ 94 N·m a radian, so the 20 N·m a standing body presses on it give 12°.
    const ankle = limitGive(1 / 0.012 + 1 / 0.12, 0.6, 4, 1 / 60);
    expect(ankle?.stiffness).toBeCloseTo(94.25, 1);
    expect(ankle?.back).toBeCloseTo(0.6);
    // A head on its neck (a ragdoll's cone: tau factor 0.8), 0.026 kg·m² each: 90 N·m a
    // radian; held level its 4 kg, 0.05 m out, rest 1.2° past the cone.
    const neck = limitGive(2 / 0.026, 0.6 * 0.8, 4, 1 / 60);
    expect(((4 * 9.81 * 0.05) / (neck?.stiffness ?? 1)) * (180 / Math.PI)).toBeCloseTo(1.25, 1);
    // Heavier bodies hold more, a longer step less (the square of it), nothing that turns none.
    expect(limitGive(2 / 0.25, 0.48, 4, 1 / 60)?.stiffness).toBeCloseTo(864, 0);
    expect(limitGive(2 / 0.25, 0.48, 4, 1 / 30)?.stiffness).toBeCloseTo(216, 0);
    expect(limitGive(0, 0.6, 4, 1 / 60)).toBeUndefined();
  });

  it("measures a joint's limit by its two bodies' inertia about the axis", () => {
    const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    const make = (inertia: number, dynamic: boolean): RAPIER.RigidBody => {
      const made = world.createRigidBody(
        dynamic ? RAPIER.RigidBodyDesc.dynamic() : RAPIER.RigidBodyDesc.fixed(),
      );
      world.createCollider(
        RAPIER.ColliderDesc.ball(0.05).setMassProperties(
          1,
          { x: 0, y: 0, z: 0 },
          { x: inertia, y: inertia * 2, z: inertia * 4 },
          { x: 0, y: 0, z: 0, w: 1 },
        ),
        made,
      );
      return made;
    };
    const frame = {
      pivot: [0, 0, 0] as [number, number, number],
      axes: [
        [1, 0, 0],
        [0, 1, 0],
      ] as [[number, number, number], [number, number, number]],
    };
    const joint = (a: RAPIER.RigidBody, b: RAPIER.RigidBody): SolverJoint => ({
      a,
      b,
      constraint: { type: 'limited-hinge', a: frame, b: frame, maxFriction: 0 },
    });
    const light = make(0.01, true);
    const heavy = make(0.1, true);
    const fixed = make(0.1, false);
    // About the axle (x): 1/0.01 + 1/0.1; about the third axis (z): a quarter of that.
    const axle = jointLimitGive(joint(light, heavy), 0, 1, 1 / 60);
    expect(axle?.stiffness).toBeCloseTo((4 * 0.6 * 3600) / 110, 1);
    const third = jointLimitGive(joint(light, heavy), 2, 1, 1 / 60);
    expect(third?.stiffness).toBeCloseTo((4 * 0.6 * 3600) / (110 / 4), 1);
    // A body nothing moves adds none; two of them give no limit.
    expect(jointLimitGive(joint(light, fixed), 0, 1, 1 / 60)?.stiffness).toBeCloseTo(86.4, 1);
    expect(jointLimitGive(joint(fixed, fixed), 0, 1, 1 / 60)).toBeUndefined();
    world.free();
  });

  // A 1 kg rod on a fixed point, hanging 0.5 rad below level against a cone of 0.3 rad, its
  // weight pressing it further down: how fast the solve leaves it turning down (rad/s).
  const pastCone = (coneGives: boolean, speed = 0): number => {
    const world = new RAPIER.World({ x: 0, y: 0, z: -9.8 });
    const anchor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const down = unitQuat(0, 1, 0, 0.5);
    const centre = rotateVec(down, [0.5, 0, 0]);
    const bob = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(centre[0], centre[1], centre[2])
        .setRotation(down)
        // Turning down about the fixed point at `speed`.
        .setAngvel({ x: 0, y: speed, z: 0 })
        .setLinvel(centre[2] * speed, 0, -centre[0] * speed)
        .setCanSleep(false),
    );
    world.createCollider(
      RAPIER.ColliderDesc.capsule(0.5, 0.02)
        .setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 })
        .setMass(1),
      bob,
    );
    const frame = {
      pivot: [0, 0, 0] as [number, number, number],
      axes: [
        [1, 0, 0],
        [0, 1, 0],
      ] as [[number, number, number], [number, number, number]],
    };
    const joint: SolverJoint = {
      a: anchor,
      b: bob,
      constraint: {
        type: 'ragdoll',
        a: frame,
        b: { ...frame, pivot: [-0.5, 0, 0] },
        maxFriction: 0,
        cone: 0.3,
      },
      coneGives,
    };
    solveJoints([joint], 1 / 60, world.gravity, 4);
    const turning = bob.angvel().y;
    world.free();
    return turning;
  };

  it('pushes a joint past its cone back by tau of the way a step, against its weight', () => {
    // 0.2 rad past: back at 0.6 × 0.8 × 0.2 × 60 = 5.76 rad/s, whatever pressed it there.
    expect(pastCone(false)).toBeCloseTo(-5.76, 0);
    expect(pastCone(false, 2)).toBeCloseTo(-5.76, 0);
  });

  it('leaves the load on a cone that gives to its spring, and takes out the speed further past it', () => {
    // Its spring's (PhysicsWorld.#giveLimits): the solve does not hold the rod's weight in the
    // spring's place (held here, the joint gave less than the rule: the weight's speed of
    // the step, 0.134 rad/s, is not what it takes out) nor push the joint back.
    expect(pastCone(true)).toBeCloseTo(0, 5);
    // What swings further past the cone is stopped, as Havok's limit takes out the speed
    // into it; what turns back into it is left.
    expect(Math.abs(pastCone(true, 2))).toBeLessThan(0.05);
    expect(pastCone(true, -2)).toBeCloseTo(-2, 4);
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

  it('pulls a powered joint to its target turn, and no further than its force allows', () => {
    // Turned 90° about z the rod points along y: a motor strong enough gets it there.
    const strong = swing({ maxForce: 200, target: Math.PI / 2, gravity: 0, seconds: 2 });
    expect(strong.toTarget).toBeLessThan(3);
    // Against its 4.9 N·m of weight (pulled up from hanging level), 2 N·m lifts nothing.
    const weak = swing({ maxForce: 2, target: Math.PI / 2, gravity: -9.8, seconds: 2, up: true });
    expect(weak.toTarget).toBeGreaterThan(80);
  });

  it("keeps a ragdoll joint's twist axis within its cone on the box's diagonal", () => {
    // Swung 45° on both swing axes (within each of Rapier's ±0.6 box limits, 60° off the twist
    // axis): the cone of 0.6 radians brings it back to about its edge.
    const off = swing({
      maxForce: 0,
      target: 0,
      gravity: 0,
      seconds: 1,
      cone: 0.6,
      diagonal: true,
    });
    expect(off.swing).toBeLessThan(0.65);
    const free = swing({ maxForce: 0, target: 0, gravity: 0, seconds: 1, diagonal: true });
    expect(free.swing).toBeGreaterThan(0.9);
  });
});

/**
 * A 1 kg rod 1 m long on a ragdoll joint at a fixed point (its twist axis along x), with no
 * friction: powered toward a turn of `target` about z (up, with `up`: about y, lifting it), or
 * started swung off (`diagonal`) within a cone. How far it is from the target (degrees) and
 * how far its twist axis is off the anchor's (radians) after `seconds`.
 */
function swing(options: {
  maxForce: number;
  target: number;
  gravity: number;
  seconds: number;
  up?: boolean;
  cone?: number;
  diagonal?: boolean;
}): { toTarget: number; swing: number } {
  const world = new RAPIER.World({ x: 0, y: 0, z: options.gravity });
  world.timestep = 1 / 60;
  const anchor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  // Diagonally off: turned so that its axis lies between y and z, 60° from x.
  const start = options.diagonal ? unitQuat(0, -1, 1, Math.PI / 3) : unitQuat(0, 0, 1, 0);
  const tip = rotateVec(start, [0.5, 0, 0]);
  const bob = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(tip[0], tip[1], tip[2])
      .setRotation(start)
      .setCanSleep(false),
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
  const axis = options.up ? ([0, -1, 0] as const) : ([0, 0, 1] as const);
  const target = unitQuat(axis[0], axis[1], axis[2], options.target);
  const frame = {
    pivot: [0, 0, 0] as [number, number, number],
    axes: [
      [1, 0, 0],
      [0, 1, 0],
    ] as [[number, number, number], [number, number, number]],
  };
  const joint: SolverJoint = {
    a: anchor,
    b: bob,
    constraint: {
      type: 'ragdoll',
      a: frame,
      b: { ...frame, pivot: [-0.5, 0, 0] },
      maxFriction: 0,
      ...(options.cone !== undefined && { cone: options.cone }),
    },
    motor:
      options.maxForce > 0
        ? {
            target,
            maxForce: options.maxForce,
            tau: 0.8,
            damping: 1,
            proportionalRecoveryVelocity: 2,
            constantRecoveryVelocity: 1,
          }
        : undefined,
  };
  for (let i = 0; i < Math.round(options.seconds * 60); i++) {
    solveJoints([joint], 1 / 60, world.gravity, world.integrationParameters.numSolverIterations);
    world.step();
  }
  const q = bob.rotation();
  const dotq = Math.abs(q.x * target.x + q.y * target.y + q.z * target.z + q.w * target.w);
  const toTarget = (2 * Math.acos(Math.min(1, dotq)) * 180) / Math.PI;
  const twist = rotateVec(q, [1, 0, 0]);
  world.free();
  return { toTarget, swing: Math.acos(Math.max(-1, Math.min(1, twist[0]))) };
}

function unitQuat(x: number, y: number, z: number, angle: number): RAPIER.Rotation {
  const length = Math.hypot(x, y, z) || 1;
  const s = Math.sin(angle / 2) / length;
  return { x: x * s, y: y * s, z: z * s, w: Math.cos(angle / 2) };
}

function rotateVec(
  q: RAPIER.Rotation,
  v: readonly [number, number, number],
): [number, number, number] {
  const [x, y, z] = v;
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  return [
    x + q.w * tx + (q.y * tz - q.z * ty),
    y + q.w * ty + (q.z * tx - q.x * tz),
    z + q.w * tz + (q.x * ty - q.y * tx),
  ];
}
