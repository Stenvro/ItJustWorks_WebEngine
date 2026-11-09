// Conformance: loose objects settling as their cell loads (engine map: Physics > World, the warm
// start). Every simulated object placed to settle comes to rest about where the plugin placed
// it, on what it was placed on, never through it. Skipped without game data where it needs it.
//
// Sources:
// - The data: the meshes of statics and the landscape are welded one-sided (bhkCompressedMeshShape
//   data, welding type anticlockwise: collision-data.ts, `oneSided`); the plugins place clutter
//   sunk into what it lies on, often deeper than half (tools/settle-audit.ts): Angarvunde's ruined
//   book [000FE3BC] in a rubble pile's hull 27 units down to the floor, the notes on the Ragged
//   Flagon's end table [000F6A70, 000F6A6F], a skull sunk into Labyrinthian's road [00104C38],
//   an oyster into Bulwark cave's floor [0403CDD2]. Two-sided, Rapier put them out at the far
//   side and they fell through (92 of the 69,455 loose objects of the interiors).
// - The engine's rule (inferred, TODO(M13) in src/physics/physics-world.ts, #weld): a welded
//   triangle puts what lies in it out at its front; while settling, a body pushed to the back of
//   a welded triangle a body may rest on (facing up, at most 60° steep) is put out at its front,
//   unless another welded triangle it lies in pushes the other way (a dagger through a table's
//   top and into its underside).
// - The Bannered Mare and Dragonsreach keep everything in place (docs/physics.md).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HAVOK_SCALE,
  type CollisionBody,
  type CollisionData,
} from '../../../src/physics/collision-data.ts';
import {
  CollisionMatrix,
  Layer,
  readCollisionMatrix,
} from '../../../src/physics/collision-layers.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from '../../../src/physics/physics-world.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { CollisionCache, settleCell, type CellSettling } from '../../../tools/settle-audit.ts';
import { hasGamedata } from '../../helpers/sim.ts';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const matrix = new CollisionMatrix([
  { formId: 1, editorId: 'L_STATIC', index: Layer.static, name: '', flags: 0, collidesWith: [4] },
  { formId: 4, editorId: 'L_CLUTTER', index: Layer.clutter, name: '', flags: 0, collidesWith: [1] },
]);

const BODY: Omit<CollisionBody, 'motion' | 'layer' | 'shapes' | 'mass' | 'centerOfMass'> = {
  node: 'Body',
  transform: IDENTITY,
  phantom: false,
  inertia: [0.05, 0.05, 0.05],
  friction: 0.5,
  restitution: 0.4,
  linearDamping: 0.1,
  angularDamping: 0.05,
  gravityFactor: 1,
  maxLinearVelocity: 104.4,
  maxAngularVelocity: 31.57,
  quality: 4,
  solverDeactivation: 1,
};

/** A welded (one-sided) floor of quads at the heights given, their fronts facing `up` or down. */
function floor(slabs: readonly { readonly z: number; readonly up: boolean }[]): CollisionData {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (const { z, up } of slabs) {
    const base = vertices.length / 3;
    vertices.push(-200, -200, z, 200, -200, z, 200, 200, z, -200, 200, z);
    // Counter-clockwise seen from the front.
    const quad = up ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
    for (const i of quad) indices.push(base + i);
  }
  const body: CollisionBody = {
    ...BODY,
    motion: 'fixed',
    layer: Layer.static,
    mass: 0,
    centerOfMass: [0, 0, 0],
    shapes: [
      {
        type: 'mesh',
        layer: Layer.static,
        material: 0,
        vertices: Float32Array.from(vertices),
        indices: Uint32Array.from(indices),
        oneSided: true,
      },
    ],
  };
  return { bodies: [body], skipped: [] };
}

/** A loose box (game units) whose base is its origin: `half` wide, `height` tall. */
function clutter(half: number, height: number): CollisionData {
  const points: number[] = [];
  for (const x of [-half, half])
    for (const y of [-half, half]) for (const z of [0, height]) points.push(x, y, z);
  const body: CollisionBody = {
    ...BODY,
    motion: 'dynamic',
    layer: Layer.clutter,
    mass: 5,
    centerOfMass: [0, 0, height / 2],
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

/** Where (game units) a box placed with its base at `z` comes to rest over `ground`. */
function settled(ground: CollisionData, box: CollisionData, z: number): number {
  const physics = new PhysicsWorld(matrix, GRAVITY);
  physics.addObject(ground, IDENTITY, { reference: 1, kind: 'object' });
  const at = new Float32Array(IDENTITY);
  at[14] = z;
  const placed = physics.addObject(box, at, { reference: 2, kind: 'object' }, false);
  // The cell's collision is complete: its loose objects settle (PlaySession.#complete).
  physics.step(physics.stepSeconds);
  physics.settle(placed);
  for (let t = 0; t < 3; t += physics.stepSeconds) physics.step(physics.stepSeconds);
  const body = placed.bodies[0]?.body;
  const rest = body ? body.translation().z * HAVOK_SCALE : NaN;
  physics.free();
  return rest;
}

beforeAll(async () => {
  await initPhysics();
});

describe('a loose object sunk into what it lies on (the engine’s rule, inferred)', () => {
  it('is put out on top of a welded floor it was placed less than half into', () => {
    expect(settled(floor([{ z: 0, up: true }]), clutter(5, 10), -3)).toBeGreaterThan(-1);
  });

  it('is put out on top of a welded floor it was placed more than half into, not under it', () => {
    // 7 of its 10 units below the floor: out of the nearer side it would go through.
    expect(settled(floor([{ z: 0, up: true }]), clutter(5, 10), -7)).toBeGreaterThan(-1);
  });

  it('stays on a table’s top it reaches through into the underside (pushed back up by the top)', () => {
    // A slab 3 units thick (its top faces up, its underside down) and a box 6 tall whose base is
    // 1 unit under the slab: the top holds it, the underside does not put it out below.
    const table = floor([
      { z: 0, up: true },
      { z: -3, up: false },
    ]);
    expect(settled(table, clutter(5, 6), -4)).toBeGreaterThan(-1);
  });

  it('is not put out through a welded surface facing down (it may not rest on one)', () => {
    // A ceiling facing down, the box pushed up into it from below by less than half: it falls
    // free under it as before, never up through it.
    const rest = settled(floor([{ z: 0, up: false }]), clutter(5, 10), -7);
    expect(rest).toBeLessThan(-10);
  });
});

describe.skipIf(!hasGamedata())('cells settle with every loose object in place (data)', () => {
  // Breezehome is not among them: unbought, it has no loose objects; bought and furnished, the
  // greatswords on its coat-of-arms plaque [00102A38, 00102A39], which WeaponRackActivateSCRIPT
  // holds as the cell attaches (docs/physics.md, "Weapon racks"), fall in this physics-only
  // settle and knock the end table's sweetroll [000CB4D7] off its plate.
  const CELLS = [
    // Kept in place before as now.
    'WhiterunBanneredMare',
    'WhiterunDragonsreach',
    // Objects placed sunk into what they lie on, which fell through it.
    'Angarvunde02',
    'RiftenThievesGuildHeadquarters',
    'Labyrinthian01',
    'DLC2RRBulwarkCave',
  ];
  let vfs: Vfs;
  let db: RecordDatabase;
  const results = new Map<string, CellSettling>();

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    const collisions = new CollisionCache(vfs);
    const matrixOfGame = await readCollisionMatrix(db);
    const byName = new Map((await db.interiorCells()).map((cell) => [cell.editorId, cell]));
    for (const name of CELLS) {
      const cell = byName.get(name);
      if (cell) results.set(name, await settleCell(db, collisions, matrixOfGame, cell.formId));
    }
  }, 600_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('loads the cells, each with loose objects to settle', () => {
    expect([...results.keys()]).toEqual(CELLS);
    for (const [name, result] of results) expect([name, result.settling > 0]).toEqual([name, true]);
  });

  it.each(CELLS)('lets none of %s’s loose objects fall through what it lies on', (name) => {
    expect(results.get(name)?.fell.map((object) => object.editorId)).toEqual([]);
  });
});
