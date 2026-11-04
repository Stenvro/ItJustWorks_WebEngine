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
import { parseNif } from '../../../src/formats/nif/nif.ts';
import {
  buildCollision,
  type CollisionBody,
  type CollisionConstraint,
  HAVOK_SCALE,
  type CollisionData,
} from '../../../src/physics/collision-data.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../../../tools/gamedata-path.ts';
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

// The six bhkBallSocketConstraintChain blocks of the data (the traps' ropes and chains: bone
// alarms, the mace, the skull ram, the tripwire) all set tau 1, damping 0.6, constraint force
// mixing float epsilon and maxErrorDistance 0.1.
describe.skipIf(!hasGamedata())('the chains (the tripwire trap)', () => {
  let collision: CollisionData | undefined;

  beforeAll(async () => {
    const vfs = await Vfs.mount(openGameFolder());
    try {
      collision = buildCollision(
        parseNif(await vfs.read('meshes\\traps\\tripwire\\traptripwire01.nif')),
      );
    } finally {
      await vfs.close();
    }
  });

  it('makes a ball and socket of each link, its error clipped to the chain’s 0.1', () => {
    const links = (collision?.constraints ?? []).filter(({ maxError }) => maxError !== undefined);
    // Its two chains: 6 and 5 links.
    expect(links).toHaveLength(11);
    for (const link of links) {
      expect(link.data.type).toBe('ball-and-socket');
      expect(link.maxError).toBeCloseTo(0.1, 6);
    }
  });
});

describe('what the world does to joints', () => {
  const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const body = (node: string, x: number, dynamic: boolean): CollisionBody => ({
    node,
    transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]),
    motion: dynamic ? 'dynamic' : 'fixed',
    phantom: false,
    layer: Layer.clutter,
    mass: dynamic ? 1 : 0,
    inertia: [0.01, 0.01, 0.01],
    centerOfMass: [0, 0, 0],
    friction: 0.5,
    restitution: 0,
    linearDamping: 0,
    angularDamping: 0,
    gravityFactor: 1,
    maxLinearVelocity: 0,
    maxAngularVelocity: 0,
    quality: 0,
    solverDeactivation: 1,
    shapes: [{ type: 'sphere', layer: Layer.clutter, material: 0, center: [0, 0, 0], radius: 5 }],
  });
  const pair = (data: CollisionConstraint['data']): CollisionData => ({
    bodies: [body('A', 0, false), body('B', 0, true)],
    constraints: [{ bodyA: 0, bodyB: 1, data }],
    skipped: [],
  });
  const frame = {
    pivot: [0, 0, 0] as const,
    axes: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
  };
  const kinds: readonly [string, CollisionConstraint['data']][] = [
    ['a ball and socket', { type: 'ball-and-socket', pivotA: [0, 0, 0], pivotB: [0, 0, 0] }],
    ['a hinge', { type: 'hinge', a: frame, b: frame } as unknown as CollisionConstraint['data']],
    ['a stiff spring', { type: 'stiff-spring', pivotA: [0, 0, 0], pivotB: [0, 0, 0], length: 0 }],
  ];

  beforeAll(async () => {
    await initPhysics();
  });

  it.each(kinds)(
    'brings %s pulled apart back by Havok’s violation a step, not at once',
    (_, data) => {
      const physics = new PhysicsWorld(new CollisionMatrix([]), 0);
      const placed = physics.addObject(pair(data), IDENTITY, { reference: 1, kind: 'object' });
      const moved = placed.bodies[1]?.body;
      if (!moved) throw new Error('no body');
      physics.settle(placed);
      physics.step(1 / 60);
      // Pulled 350 units (5 Havok units) off its pivot.
      moved.setTranslation({ x: 5, y: 0, z: 0 }, true);
      physics.step(1 / 60);
      // It comes back by little in a step; unclipped, the solver took all of it at once.
      expect(moved.translation().x).toBeGreaterThan(4);
      for (let i = 0; i < 600; i++) physics.step(1 / 60);
      expect(moved.translation().x).toBeLessThan(0.5);
      physics.free();
    },
  );

  it('holds a ragdoll stiff in the pose it was taken in, and lets it go (the paralysed)', () => {
    const physics = new PhysicsWorld(new CollisionMatrix([]), GRAVITY);
    const placed = physics.addObject(
      pair({ type: 'ball-and-socket', pivotA: [0, 0, 0], pivotB: [-20, 0, 0] }),
      IDENTITY,
      { reference: 1, kind: 'object' },
    );
    const moved = placed.bodies[1]?.body;
    if (!moved) throw new Error('no body');
    physics.settle(placed);
    moved.setTranslation({ x: 20 / HAVOK_SCALE, y: 0, z: 0 }, true);
    physics.stiffen(placed, true);
    for (let i = 0; i < 60; i++) physics.step(1 / 60);
    // Held out level from what it hangs on, as it was.
    expect(moved.translation().z * HAVOK_SCALE).toBeGreaterThan(-3);
    physics.stiffen(placed, false);
    for (let i = 0; i < 60; i++) physics.step(1 / 60);
    expect(moved.translation().z * HAVOK_SCALE).toBeLessThan(-10);
    physics.free();
  });
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
