// Conformance: what puts a simulated body to sleep (engine map: Physics > World, time step).
// Havok deactivates by place: a body is inactive while it stays within the world's deactivation
// reference distance (and turn) of where it last moved, and a system inactive for a second as a
// whole goes to sleep. Nothing else does: a body that keeps moving, however slowly, stays
// active. Rapier's own sleeping (by speed alone, after half a second under 0.1 units a second)
// must not put a body to sleep before that rule does.
//
// Sources:
// - Havok's deactivation (src/physics/physics-world.ts, PhysicsWorld.#deactivate; docs/physics.md,
//   "How a ragdoll comes to rest"): the reference distance observed in the original, 0.02 Havok
//   units, the rest inferred from Havok's documented behaviour.
// - The data: every body's deactivator type is 1 (tools/animation-physics-completeness.ts,
//   "Deactivator types"): the world's deactivation runs for all, none is left out of it.

import { beforeAll, describe, expect, it } from 'vitest';
import type { CollisionBody, CollisionData } from '../../../src/physics/collision-data.ts';
import { CollisionMatrix, Layer } from '../../../src/physics/collision-layers.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from '../../../src/physics/physics-world.ts';
import type RAPIER from '@dimforge/rapier3d-compat';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const matrix = new CollisionMatrix([
  { formId: 1, editorId: 'L_STATIC', index: Layer.static, name: '', flags: 0, collidesWith: [4] },
  { formId: 4, editorId: 'L_CLUTTER', index: Layer.clutter, name: '', flags: 0, collidesWith: [1] },
]);

/**
 * A loose box of a size (game units) with no friction and no damping, its solver deactivation
 * off: nothing but the deactivation can stop it.
 */
function box(half: number): CollisionBody {
  const points: number[] = [];
  for (const x of [-half, half])
    for (const y of [-half, half]) for (const z of [0, 2 * half]) points.push(x, y, z);
  return {
    node: 'Box',
    transform: IDENTITY,
    motion: 'dynamic',
    phantom: false,
    layer: Layer.clutter,
    mass: 5,
    inertia: [0.05, 0.05, 0.05],
    centerOfMass: [0, 0, half],
    friction: 0,
    restitution: 0,
    linearDamping: 0,
    angularDamping: 0,
    gravityFactor: 1,
    maxLinearVelocity: 104.4,
    maxAngularVelocity: 31.57,
    quality: 4,
    solverDeactivation: 1,
    shapes: [
      {
        type: 'convex',
        layer: Layer.clutter,
        material: 0,
        points: Float32Array.from(points),
        radius: 0,
      },
    ],
  };
}

function loose(half: number): CollisionData {
  return { bodies: [box(half)], skipped: [] };
}

/** A world with a wide, frictionless floor whose top is at 0. */
function withFloor(): PhysicsWorld {
  const physics = new PhysicsWorld(matrix, GRAVITY);
  const base = box(2000);
  physics.addObject(
    {
      bodies: [
        {
          ...base,
          motion: 'fixed',
          layer: Layer.static,
          mass: 0,
          shapes: base.shapes.map((s) => ({ ...s, layer: Layer.static })),
        },
      ],
      skipped: [],
    },
    new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -4000, 1]),
    { reference: 2, kind: 'object' },
    false,
  );
  return physics;
}

/** A box settled on the floor until it sleeps (the warm start, then the deactivation). */
function settledBox(physics: PhysicsWorld): RAPIER.RigidBody {
  const placed = physics.addObject(loose(5), IDENTITY, { reference: 1, kind: 'object' }, false);
  const body = placed.bodies[0]?.body;
  if (!body) throw new Error('no body');
  physics.step(1 / 60);
  physics.settle(placed);
  for (let i = 0; i < 8 * 60 && !body.isSleeping(); i++) physics.step(1 / 60);
  if (!body.isSleeping()) throw new Error('the box did not settle');
  return body;
}

beforeAll(async () => {
  await initPhysics();
});

describe('deactivation by place, not by speed (Havok’s rule)', () => {
  it('keeps a box sliding slowly over a floor moving: it never stays near where it was', () => {
    const physics = withFloor();
    const body = settledBox(physics);
    // 0.05 Havok units a second (3.5 game units): under Rapier's sleep speed, yet the box
    // leaves the deactivation's 0.02 units within half a second, again and again.
    body.wakeUp();
    body.setLinvel({ x: 0.05, y: 0, z: 0 }, true);
    const start = body.translation().x;
    let sleptAt: number | undefined;
    for (let i = 0; i < 5 * 60; i++) {
      physics.step(1 / 60);
      if (sleptAt === undefined && body.isSleeping()) sleptAt = (i + 1) / 60;
    }
    const moved = body.translation().x - start;
    physics.free();
    expect(sleptAt).toBeUndefined();
    expect(moved).toBeCloseTo(0.25, 2);
  });

  it('keeps a box turning slowly moving: it never stays near the way it faced', () => {
    const physics = new PhysicsWorld(new CollisionMatrix([]), GRAVITY);
    const placed = physics.addObject(loose(5), IDENTITY, { reference: 1, kind: 'object' }, false);
    const body = placed.bodies[0]?.body;
    if (!body) throw new Error('no body');
    physics.release(body);
    body.setGravityScale(0, true);
    // 0.1 radians a second: under Rapier's sleep speed, past the deactivation's 0.05 radians
    // within a second.
    body.setAngvel({ x: 0, y: 0, z: 0.1 }, true);
    let sleptAt: number | undefined;
    for (let i = 0; i < 5 * 60; i++) {
      physics.step(1 / 60);
      if (sleptAt === undefined && body.isSleeping()) sleptAt = (i + 1) / 60;
    }
    const q = body.rotation();
    const turned = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
    physics.free();
    expect(sleptAt).toBeUndefined();
    expect(turned).toBeCloseTo(0.5, 2);
  });

  it('puts a box at rest to sleep after a second of it (at the quarter-second checks), not before', () => {
    const physics = withFloor();
    const body = settledBox(physics);
    // Woken where it lies, it does not move: inactive from the first check on.
    body.wakeUp();
    let sleptAt: number | undefined;
    for (let i = 0; i < 3 * 60 && sleptAt === undefined; i++) {
      physics.step(1 / 60);
      if (body.isSleeping()) sleptAt = (i + 1) / 60;
    }
    physics.free();
    expect(sleptAt).toBeDefined();
    expect(sleptAt ?? 0).toBeGreaterThanOrEqual(1);
    expect(sleptAt ?? 0).toBeLessThanOrEqual(1.5);
  });

  it('places a body that does not settle ("Don’t Havok Settle") asleep, and it stays so', () => {
    const physics = new PhysicsWorld(new CollisionMatrix([]), GRAVITY);
    const placed = physics.addObject(loose(5), IDENTITY, { reference: 1, kind: 'object' }, false);
    const body = placed.bodies[0]?.body;
    if (!body) throw new Error('no body');
    const asleep = body.isSleeping();
    for (let i = 0; i < 60; i++) physics.step(1 / 60);
    const z = body.translation().z;
    physics.free();
    expect(asleep).toBe(true);
    expect(z).toBe(0);
  });
});
