// Conformance: constraints (engine map: Physics > Constraints). The Havok constraints of the
// models (hinged signs, chains, hanging game, ragdolls) as the engine's solver holds them, and
// those scripts make between references.
//
// Sources:
// - The engine's rule, observed in the original (src/physics/constraint-solver.ts; docs/physics.md): the
//   world's solver runs at fMaxTime with tau 0.6 (from fHavokTauRatio 0.5) and damping 1, four
//   iterations; ragdoll limits are eased by tau × 0.8 and hinge limits by tau; a joint's error is
//   clipped to Havok's maximum constraint violation; slow bodies are slowed by their solver
//   deactivation class.
// - The data: the constraint blocks nif.xml defines for Skyrim SE (bhkRagdollConstraint,
//   bhkLimitedHingeConstraint, bhkHingeConstraint, bhkBallAndSocketConstraint,
//   bhkPrismaticConstraint, bhkStiffSpringConstraint, bhkMalleableConstraint, bhkBreakable
//   Constraint); the base scripts' natives (`node tools/papyrus-natives.ts --placeholders`):
//   Game.AddHavokBallAndSocketConstraint (9 calls in the game's scripts) and
//   Game.RemoveHavokConstraints (3).
// - The settings' built-in values (the engine's defaults): fHavokTauRatio 0.5, [HAVOK]
//   bUseConstraintProjector 1.

import { beforeAll, describe, expect, it } from 'vitest';
import { HAVOK_SCALE, type CollisionData } from '../../../src/physics/collision-data.ts';
import { CollisionMatrix, Layer } from '../../../src/physics/collision-layers.ts';
import {
  bodyOfNode,
  GRAVITY,
  initPhysics,
  PhysicsWorld,
} from '../../../src/physics/physics-world.ts';
import {
  easedLimit,
  HINGE_LIMIT_TAU_FACTOR,
  RAGDOLL_LIMIT_TAU_FACTOR,
  SOLVER_DEFAULTS,
  slowBodyFactor,
  solverSettings,
} from '../../../src/physics/constraint-solver.ts';

describe('the constraint solver (the engine’s rule)', () => {
  it('solves at fMaxTime with tau 0.6 (fHavokTauRatio 0.5), damping 1, four iterations', () => {
    expect(solverSettings(1 / 60, 1 / 60, 0.5)).toEqual({ tau: 0.6, damping: 1, iterations: 4 });
    expect(SOLVER_DEFAULTS).toEqual({ tau: 0.6, damping: 1, iterations: 4 });
  });

  it('eases a ragdoll’s limit by tau × 0.8 and a hinge’s by tau of the way a step', () => {
    expect(RAGDOLL_LIMIT_TAU_FACTOR).toBe(0.8);
    expect(HINGE_LIMIT_TAU_FACTOR).toBe(1);
    const tau = SOLVER_DEFAULTS.tau * RAGDOLL_LIMIT_TAU_FACTOR;
    const [low] = easedLimit(-1, -0.2, 0.5, tau) ?? [0, 0];
    expect(low).toBeCloseTo(-1 + tau * 0.8);
  });

  it('slows slow bodies by their solver deactivation class, the higher the more', () => {
    const low = slowBodyFactor(2, 9.8, 0.05, 0.01, 4);
    expect(slowBodyFactor(1, 9.8, 0.05, 0.01, 4)).toBe(1);
    expect(slowBodyFactor(5, 9.8, 0.05, 0.01, 4)).toBeLessThan(low);
  });

  it.todo(
    'holds every constraint type of the vanilla meshes (a census of bhk*Constraint blocks by ' +
      'type, each built)  [data: nif.xml] (data sweep)',
  );
  it.todo(
    'breaks a breakable constraint when a step pulls on it beyond its threshold, as the ' +
      'hanging signs of Riverwood fall when shot  [data] (sim)',
  );
  it.todo('drives no motor (no vanilla constraint has one)  [data] (data sweep)');
  it.todo(
    'projects joints back together with the constraint projector ([HAVOK] ' +
      'bUseConstraintProjector 1)  [settings; original: unread]',
  );
});

describe('constraints made by scripts', () => {
  const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const matrix = new CollisionMatrix([
    { formId: 1, editorId: 'L_STATIC', index: Layer.static, name: '', flags: 0, collidesWith: [] },
    {
      formId: 4,
      editorId: 'L_CLUTTER',
      index: Layer.clutter,
      name: '',
      flags: 0,
      collidesWith: [],
    },
  ]);
  /** A body on a node: a 10-unit box, fixed (a hook) or simulated (a key, 1 kg). */
  const part = (node: string, dynamic: boolean): CollisionData => {
    const points: number[] = [];
    for (const x of [-5, 5]) for (const y of [-5, 5]) for (const z of [-5, 5]) points.push(x, y, z);
    const layer = dynamic ? Layer.clutter : Layer.static;
    return {
      bodies: [
        {
          node,
          transform: IDENTITY,
          motion: dynamic ? 'dynamic' : 'fixed',
          phantom: false,
          layer,
          mass: dynamic ? 1 : 0,
          inertia: [0.01, 0.01, 0.01],
          centerOfMass: [0, 0, 0],
          friction: 0.5,
          restitution: 0.4,
          linearDamping: 0,
          angularDamping: 0.05,
          gravityFactor: 1,
          maxLinearVelocity: 0,
          maxAngularVelocity: 0,
          quality: 0,
          solverDeactivation: 1,
          shapes: [
            { type: 'convex', layer, material: 0, points: Float32Array.from(points), radius: 0 },
          ],
        },
      ],
      skipped: [],
    };
  };

  beforeAll(async () => {
    await initPhysics();
  });

  it(
    'joins two references’ nodes with a ball and socket (Game.AddHavokBallAndSocketConstraint, ' +
      'at the nodes’ local offsets), and removes it (Game.RemoveHavokConstraints): the body ' +
      'falls free  [data: 9 and 3 calls]',
    () => {
      const physics = new PhysicsWorld(matrix, GRAVITY);
      const hook = physics.addObject(part('Hook', false), IDENTITY, {
        reference: 1,
        kind: 'object',
      });
      const key = physics.addObject(part('Key', true), IDENTITY, { reference: 2, kind: 'object' });
      const hookBody = bodyOfNode([hook], 'hook');
      const keyBody = bodyOfNode([key], '');
      if (!hookBody || !keyBody) throw new Error('no bodies');
      expect(bodyOfNode([key], 'Nothing')).toBeUndefined();
      // The key hangs 20 units under the hook's middle, by its own middle.
      expect(physics.joinBallAndSocket(hookBody, [0, 0, -20], keyBody, [0, 0, 0])).toBe(true);
      for (let i = 0; i < 120; i++) physics.step(1 / 60);
      const z = (): number => keyBody.body.translation().z * HAVOK_SCALE;
      expect(z()).toBeGreaterThan(-25);
      expect(z()).toBeLessThan(-15);
      expect(physics.removeScriptJoints(hookBody, keyBody)).toBe(1);
      for (let i = 0; i < 30; i++) physics.step(1 / 60);
      expect(z()).toBeLessThan(-60);
      physics.free();
    },
  );
  it.todo('keeps a script-made constraint across its cell’s unload and load  [original] (sim)');
});
