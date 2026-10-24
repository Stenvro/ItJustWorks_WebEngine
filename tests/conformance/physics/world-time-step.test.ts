// Conformance: the physics world and its time step (engine map: Physics > World, time step). How
// the engine steps Havok each frame, the bodies' quality and top speeds, deactivation, and the
// warm start that settles a loaded cell's loose objects where the plugins placed them. Skipped
// without game data where it needs it.
//
// Sources:
// - The engine's rule, observed in the original (src/physics/physics-world.ts, PhysicsWorld.step): a frame
//   hands Havok its time plus the time still owed, at most uMaxNumPhysicsStepsPerUpdate × fMaxTime
//   (the rest stays owed), nothing below a millisecond (owed too); Havok steps fMaxTime until its
//   clock reaches what it was handed. The step and its cap scale with the world's time
//   multiplier; the solver runs max(4, ⌈3.9 × multiplier⌉) iterations; fTimePerSubStep and
//   iMinNumSubSteps are read by nothing.
// - The settings' built-in values (the engine's defaults): [HAVOK] fMaxTime 1/60,
//   uMaxNumPhysicsStepsPerUpdate 3, fMaxTimeComplex 1/30, uMaxNumPhysicsStepsPerUpdateComplex 1,
//   fWarmStartMaxTime 4, bAllowDeactivationWhileWarmStarting 0; fDebrisMinExtent 2,
//   fDebrisMaxVelocity 25.
// - The data: every interior cell's loose objects (tools/settle-audit.ts); Mistwatch01
//   [0003F516] and its bear traps (BearTrap01 [0007144D], meshes/traps/beartrap/beartrap01.nif:
//   a simulated root body on L_CLUTTER whose hull is a disc 0.2 units thick in a 3.5-unit shell)
//   on ImpTowerOutFloor01's compressed mesh.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CollisionBody, CollisionData } from '../../../src/physics/collision-data.ts';
import {
  CollisionMatrix,
  Layer,
  readCollisionMatrix,
} from '../../../src/physics/collision-layers.ts';
import {
  DEBRIS_QUALITY,
  GRAVITY,
  initPhysics,
  MAX_STEPS_PER_UPDATE,
  MIN_FRAME_SECONDS,
  PHYSICS_STEP,
  PhysicsWorld,
  sweptBody,
} from '../../../src/physics/physics-world.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { CollisionCache, settleCell, type CellSettling } from '../../../tools/settle-audit.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const matrix = new CollisionMatrix([
  { formId: 1, editorId: 'L_STATIC', index: Layer.static, name: '', flags: 0, collidesWith: [4] },
  { formId: 4, editorId: 'L_CLUTTER', index: Layer.clutter, name: '', flags: 0, collidesWith: [1] },
]);

/** A loose box of a size (game units), as the files make clutter. */
function clutter(half: number, maxLinearVelocity = 104.4, quality = 4): CollisionData {
  const points: number[] = [];
  for (const x of [-half, half])
    for (const y of [-half, half]) for (const z of [0, 2 * half]) points.push(x, y, z);
  const body: CollisionBody = {
    node: 'Box',
    transform: IDENTITY,
    motion: 'dynamic',
    phantom: false,
    layer: Layer.clutter,
    mass: 5,
    inertia: [0.05, 0.05, 0.05],
    centerOfMass: [0, 0, half],
    friction: 0.5,
    restitution: 0.4,
    linearDamping: 0,
    angularDamping: 0.05,
    gravityFactor: 1,
    maxLinearVelocity,
    maxAngularVelocity: 31.57,
    quality,
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
  return { bodies: [body], skipped: [] };
}

beforeAll(async () => {
  await initPhysics();
});

describe('the step (the engine’s rule)', () => {
  it('steps fMaxTime (1/60 s), at most uMaxNumPhysicsStepsPerUpdate (3) a frame', () => {
    expect(PHYSICS_STEP).toBeCloseTo(1 / 60, 9);
    expect(MAX_STEPS_PER_UPDATE).toBe(3);
    const physics = new PhysicsWorld(matrix, GRAVITY);
    expect(physics.step(1 / 60)).toBe(1);
    expect(physics.step(0.1)).toBe(3);
    physics.free();
  });

  it('makes a long frame’s rest up in the frames after it (the time is owed, not lost)', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const frames = [1 / 60, 0.1, 1 / 60, 1 / 60, 1 / 60];
    const steps = frames.map((seconds) => physics.step(seconds));
    expect(steps).toEqual([1, 3, 3, 2, 1]);
    // As many steps as the time that passed.
    const passed = frames.reduce((sum, seconds) => sum + seconds, 0);
    expect(steps.reduce((sum, n) => sum + n, 0)).toBe(Math.round(passed / PHYSICS_STEP));
    physics.free();
  });

  it('steps nothing in a frame under a millisecond, and owes its time', () => {
    expect(MIN_FRAME_SECONDS).toBe(0.001);
    const physics = new PhysicsWorld(matrix, GRAVITY);
    expect(physics.step(0.0009)).toBe(0);
    // Owed and the next one's together pass a millisecond: Havok steps to them.
    expect(physics.step(0.0009)).toBe(1);
    physics.free();
  });

  it('steps until Havok’s clock reaches the frame’s (a short frame may take a whole step)', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    // Frames of 1/120 s: a step every other frame.
    expect([1, 2, 3, 4].map(() => physics.step(1 / 120))).toEqual([1, 0, 1, 0]);
    physics.free();
  });

  it.fails(
    'runs the solver max(4, ⌈3.9 × time multiplier⌉) iterations: 4 at normal speed  [original] ' +
      'TODO(M13): Rapier runs 8 (with 4 the settled clutter of Jorrvaskr kept creeping)',
    () => {
      const physics = new PhysicsWorld(matrix, GRAVITY);
      const iterations = physics.world.integrationParameters.numSolverIterations;
      physics.free();
      expect(iterations).toBe(4);
    },
  );

  it.todo(
    'scales the step and its cap by the world’s time multiplier (Slow Time steps smaller)  [original]',
  );
  it.todo(
    'steps fMaxTimeComplex (1/30 s) once a frame in the engine’s complex mode  [original: what turns ' +
      'it on is not identified]',
  );
});

describe('simulated bodies (the engine’s rules)', () => {
  it('sweeps small, fast bodies (fDebrisMinExtent 2, fDebrisMaxVelocity 25), not large or slow ones', () => {
    expect(DEBRIS_QUALITY).toEqual({ minExtent: 2, maxVelocity: 25 });
    const cup = clutter(5).bodies[0];
    const cart = clutter(80).bodies[0];
    const slow = clutter(5, 0.3).bodies[0];
    if (!cup || !cart || !slow) throw new Error('no body');
    expect(sweptBody(cup, 1, DEBRIS_QUALITY)).toBe(true);
    expect(sweptBody(cart, 1, DEBRIS_QUALITY)).toBe(false);
    expect(sweptBody(slow, 1, DEBRIS_QUALITY)).toBe(false);
  });

  it('holds a body to the file’s maximum linear velocity, as Havok’s motion clamps it', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const placed = physics.addObject(
      clutter(5, 2),
      IDENTITY,
      { reference: 1, kind: 'object' },
      false,
    );
    const falling = placed.bodies[0]?.body;
    if (falling) physics.release(falling);
    for (let i = 0; i < 60; i++) physics.step(1 / 60);
    const v = falling?.linvel() ?? { x: 0, y: 0, z: 0 };
    expect(Math.hypot(v.x, v.y, v.z)).toBeLessThanOrEqual(2.001);
    physics.free();
  });

  it('settles a loose object on a floor and puts it to sleep (deactivation)', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const floor = clutter(200);
    const base = floor.bodies[0];
    if (!base) throw new Error('no body');
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
      new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -400, 1]),
      { reference: 2, kind: 'object' },
      false,
    );
    const placed = physics.addObject(clutter(5), IDENTITY, { reference: 1, kind: 'object' }, false);
    physics.step(1 / 60);
    physics.settle(placed);
    for (let i = 0; i < 6 * 60; i++) physics.step(1 / 60);
    const body = placed.bodies[0]?.body;
    expect(body?.translation().z ?? -1).toBeCloseTo(0, 1);
    expect(body?.isSleeping()).toBe(true);
    physics.free();
  });

  it.todo(
    'keeps settling bodies awake for fWarmStartMaxTime (4 s) at most, never deactivated while ' +
      'warm starting (bAllowDeactivationWhileWarmStarting 0)  [settings; original]',
  );
  it.todo('removes bodies that leave the Havok world’s bounds  [original: unread]');
});

describe.skipIf(!hasGamedata())(
  'every loose object of every interior settles where placed (data)',
  () => {
    let vfs: Vfs;
    let db: RecordDatabase;
    let collisions: CollisionCache;
    let matrixOfGame: CollisionMatrix;
    const results = new Map<string, CellSettling>();

    beforeAll(async () => {
      vfs = await Vfs.mount(openGameFolder());
      db = await RecordDatabase.open(vfs);
      collisions = new CollisionCache(vfs);
      matrixOfGame = await readCollisionMatrix(db);
      for (const cell of await db.interiorCells()) {
        results.set(cell.editorId, await settleCell(db, collisions, matrixOfGame, cell.formId, 2));
      }
    }, 1_200_000);
    afterAll(async () => {
      await db.close();
      await vfs.close();
    });

    it('settles the 69,455 loose objects of the 761 interior cells', () => {
      expect(results.size).toBe(761);
      let settling = 0;
      for (const result of results.values()) settling += result.settling;
      expect(settling).toBe(69455);
    });

    it('leaves Mistwatch’s bear traps, pitchforks and the rest on their floors', () => {
      for (const name of ['Mistwatch01', 'Mistwatch03']) {
        expect(results.get(name)?.fell.map((object) => object.editorId)).toEqual([]);
      }
    });

    it.fails(
      'lets none fall through what it was placed on  TODO(M13): objects placed into what they ' +
        'lie on (a knife stuck in a table, an urn chunk in a wall) are pushed out through it',
      () => {
        let fell = 0;
        for (const result of results.values()) fell += result.fell.length;
        expect(fell).toBe(0);
      },
    );
  },
);

const MISTWATCH_NORTH_TOWER = 0x3f516;
const BEAR_TRAPS = [0x1054a9, 0xc00fd, 0xc00fe];

describe.skipIf(!hasGamedata())(
  'Mistwatch’s bear traps after the cell loads (headless simulation)',
  () => {
    let sim: Sim;
    const placed = new Map<number, number>();
    const after = new Map<number, number>();

    beforeAll(async () => {
      sim = await openSim({ interior: MISTWATCH_NORTH_TOWER, hour: 10 });
      for (const trap of BEAR_TRAPS) {
        const world = sim.world.placed(trap)?.instance.world;
        if (world) placed.set(trap, world[14] ?? 0);
      }
      await sim.step(8);
      for (const trap of BEAR_TRAPS) {
        const world = sim.world.placed(trap)?.instance.world;
        if (world) after.set(trap, world[14] ?? 0);
      }
    }, 600_000);
    afterAll(async () => {
      await sim.close();
    });

    it('places the three bear traps of the tower, simulated', () => {
      expect(placed.size).toBe(3);
    });

    it('keeps each within a few units of its placed height (none falls through the floor)', () => {
      for (const trap of BEAR_TRAPS) {
        expect(Math.abs((placed.get(trap) ?? 0) - (after.get(trap) ?? Infinity))).toBeLessThan(4);
      }
    });
  },
);
