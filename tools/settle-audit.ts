// Places cells' collision in a physics world as a loaded cell has it and lets their loose objects
// settle (the engine's warm start, src/shell/play-session.ts): every simulated object placed to
// settle should come to rest about where the plugin placed it, on what it was placed on, never
// through it, nor out on top of what it was placed under. Prints the objects that end lower than
// their placed spot by more than their own size with something between their placed spot and
// where they ended (they fell through it), and those that end higher than placed by more than a
// few units (lifted), per cell and in all. An articulated object with a placed ragdoll pose
// (XRGD: an open book, armour on the floor) is posed by it as the session poses it, and stays at
// rest where the walk is complete.
//
//   node tools/settle-audit.ts                     every interior cell
//   node tools/settle-audit.ts mistwatch           interior cells whose editor id contains it
//   node tools/settle-audit.ts --seconds 8 dungeon

import type { SkeletonNode } from '../src/animation/animated-skeleton.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { articulatedPose } from '../src/physics/articulation.ts';
import {
  buildCollision,
  HAVOK_SCALE,
  isArticulated,
  settlesWhenPlaced,
  type CollisionData,
} from '../src/physics/collision-data.ts';
import {
  Layer,
  readCollisionMatrix,
  type CollisionMatrix,
} from '../src/physics/collision-layers.ts';
import { landscapeMesh } from '../src/physics/landscape.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from '../src/physics/physics-world.ts';
import { loadCellData } from '../src/world/cell-loader.ts';
import { enabledReferences, findToggles, gameStartSelection } from '../src/world/cell-upgrades.ts';
import { poseObjectRagdoll } from '../src/world/ragdoll-data.ts';
import { buildModel } from '../src/render/model-data.ts';
import type { LandData } from '../src/world/land.ts';
import type { RecordDatabase } from '../src/world/record-db.ts';
import type { Vfs } from '../src/vfs/vfs.ts';

/** An object that ended lower than its placed spot by more than its size. */
export interface FallenObject {
  readonly reference: number;
  readonly editorId: string;
  readonly model: string;
  /** How far its body's origin ended below where it was placed (game units). */
  readonly drop: number;
}

/** An object that ended higher than its placed spot by more than LIFT_SLACK. */
export interface LiftedObject {
  readonly reference: number;
  readonly editorId: string;
  readonly model: string;
  /** How far its body's origin ended above where it was placed (game units). */
  readonly rise: number;
}

export interface CellSettling {
  /** Simulated objects placed to settle. */
  readonly settling: number;
  readonly fell: readonly FallenObject[];
  /**
   * Objects that ended higher than placed by more than LIFT_SLACK: put out on top of what they
   * were placed under or in, or thrown.
   */
  readonly lifted: readonly LiftedObject[];
  /** How far each watched object ended from where it was placed (x, y, z: game units). */
  readonly moved: ReadonlyMap<number, readonly [number, number, number]>;
  /**
   * Objects that ended lower with nothing between: rolled or tipped off what they were on, or
   * placed over nothing (as at a cell's origin, for a script to move).
   */
  readonly droppedOff: number;
}

/** How far an object may end lower than placed: tipping over, rolling off a shelf (game units). */
const FALL_SLACK = 8;
/**
 * How far an object may end higher than placed (game units): put out of a floor or a table's
 * top it was placed a little into, tipping up on an edge.
 */
export const LIFT_SLACK = 8;

/** Reads collision (and an articulated model's nodes) once per model. */
export class CollisionCache {
  readonly #vfs: Vfs;
  readonly #cache = new Map<string, CollisionData | undefined>();
  readonly #nodes = new Map<string, readonly SkeletonNode[] | undefined>();

  constructor(vfs: Vfs) {
    this.#vfs = vfs;
  }

  async get(model: string): Promise<CollisionData | undefined> {
    const key = model.toLowerCase();
    if (this.#cache.has(key)) return this.#cache.get(key);
    let collision: CollisionData | undefined;
    try {
      const path = key.startsWith('meshes\\') || key.startsWith('meshes/') ? key : `meshes\\${key}`;
      if (this.#vfs.has(path)) collision = buildCollision(parseNif(await this.#vfs.read(path)));
    } catch {
      collision = undefined;
    }
    this.#cache.set(key, collision);
    return collision;
  }

  /** An articulated model's nodes (its bodies move them one by one: isArticulated). */
  async nodes(model: string): Promise<readonly SkeletonNode[] | undefined> {
    const key = model.toLowerCase();
    if (this.#nodes.has(key)) return this.#nodes.get(key);
    let nodes: readonly SkeletonNode[] | undefined;
    try {
      const path = key.startsWith('meshes\\') || key.startsWith('meshes/') ? key : `meshes\\${key}`;
      if (this.#vfs.has(path)) nodes = buildModel(parseNif(await this.#vfs.read(path))).nodes;
    } catch {
      nodes = undefined;
    }
    this.#nodes.set(key, nodes);
    return nodes;
  }
}

/**
 * Settles one cell's loose objects for `seconds` (physics only: no scripts, actors or graphs)
 * and reports those that fell through what they were placed on. An exterior cell's objects
 * settle on its landscape (`land`: its heights and grid position), as the session places it.
 */
export async function settleCell(
  db: RecordDatabase,
  collisions: CollisionCache,
  matrix: CollisionMatrix,
  cell: number,
  seconds = 5,
  land?: { readonly data: LandData; readonly x: number; readonly y: number },
): Promise<CellSettling> {
  await initPhysics();
  const data = await loadCellData(db, cell);
  const toggles = findToggles(data);
  const enabled = enabledReferences(data, toggles, gameStartSelection(toggles));
  const physics = new PhysicsWorld(matrix, GRAVITY);
  const watched: {
    reference: number;
    editorId: string;
    model: string;
    body: ReturnType<PhysicsWorld['addObject']>['bodies'][number]['body'];
    x: number;
    y: number;
    z: number;
    size: number;
  }[] = [];
  const settle: ReturnType<PhysicsWorld['addObject']>[] = [];
  try {
    if (land) {
      const { vertices, indices } = landscapeMesh(land.data, land.x, land.y);
      physics.addMesh(vertices, indices, Layer.ground, { reference: 0, kind: 'landscape' }, true);
    }
    for (const object of data.objects) {
      if (!enabled(object.reference) || !object.model) continue;
      const collision = await collisions.get(object.model);
      if (!collision || collision.bodies.length === 0) continue;
      const placed = physics.addObject(
        collision,
        object.world,
        { reference: object.reference, kind: 'object' },
        false,
      );
      // An articulated object's placed ragdoll pose, as the session applies it (play-session.ts).
      const articulated =
        object.ragdoll && isArticulated(collision)
          ? articulatedPose(await collisions.nodes(object.model), collision)
          : undefined;
      const posed = articulated
        ? poseObjectRagdoll(physics, placed, articulated.pose, collision, object)
        : undefined;
      const settles = posed ? !posed.complete : settlesWhenPlaced(object);
      if (!settles || !placed.dynamic) continue;
      settle.push(placed);
      const moving = placed.bodies.find(
        ({ data: body }) => body.motion === 'dynamic' && !body.phantom,
      );
      if (!moving) continue;
      watched.push({
        reference: object.reference,
        editorId: object.editorId,
        model: object.model,
        body: moving.body,
        x: moving.body.translation().x,
        y: moving.body.translation().y,
        z: moving.body.translation().z,
        size: extentOf(collision) * placed.scale,
      });
    }
    for (const primitive of data.primitives) {
      if (!enabled(primitive.reference) || primitive.layer === Layer.trigger) continue;
      physics.addPrimitive(primitive.shape, primitive.bounds, primitive.world, primitive.layer, {
        reference: primitive.reference,
        kind: 'object',
      });
    }
    // The cell's collision is complete: its loose objects settle (PlaySession.#complete).
    physics.step(physics.stepSeconds);
    for (const placed of settle) physics.settle(placed);
    for (let t = 0; t < seconds; t += physics.stepSeconds) physics.step(physics.stepSeconds);
    const fell: FallenObject[] = [];
    const lifted: LiftedObject[] = [];
    const moved = new Map<number, readonly [number, number, number]>();
    let droppedOff = 0;
    // Only what does not move is a surface it may have gone through.
    const moving = (collider: { parent(): { isDynamic(): boolean } | null }): boolean =>
      collider.parent()?.isDynamic() === true;
    for (const entry of watched) {
      const at = entry.body.translation();
      const [x, y, z] = [at.x * HAVOK_SCALE, at.y * HAVOK_SCALE, at.z * HAVOK_SCALE];
      const start = entry.z * HAVOK_SCALE;
      const drop = start - z;
      moved.set(entry.reference, [x - entry.x * HAVOK_SCALE, y - entry.y * HAVOK_SCALE, -drop]);
      if (-drop > LIFT_SLACK) {
        lifted.push({
          reference: entry.reference,
          editorId: entry.editorId,
          model: entry.model,
          rise: -drop,
        });
      }
      if (!(drop > entry.size + FALL_SLACK)) continue;
      // Gone through something: where it ended, a surface lies between its placed height and it
      // (one that tipped off a table lies on the floor beside it; one placed over nothing, as at
      // a cell's origin for a script to move, falls through nothing).
      const surface = physics.raycast(
        [x, y, start + 1],
        [0, 0, -1],
        Math.max(0, drop - FALL_SLACK),
        Layer.clutter,
        undefined,
        undefined,
        moving,
      );
      if (!surface) {
        droppedOff++;
        continue;
      }
      fell.push({ reference: entry.reference, editorId: entry.editorId, model: entry.model, drop });
    }
    return { settling: watched.length, fell, lifted, droppedOff, moved };
  } finally {
    physics.world.free();
  }
}

/** The largest extent of a model's collision (game units): how far it may drop by tipping. */
function extentOf(collision: CollisionData): number {
  let largest = 0;
  for (const body of collision.bodies) {
    for (const shape of body.shapes) {
      const points =
        shape.type === 'convex' ? shape.points : shape.type === 'mesh' ? shape.vertices : undefined;
      if (points) {
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i + 2 < points.length; i += 3) {
          for (let axis = 0; axis < 3; axis++) {
            const v = points[i + axis] ?? 0;
            min[axis] = Math.min(min[axis] ?? 0, v);
            max[axis] = Math.max(max[axis] ?? 0, v);
          }
        }
        largest = Math.max(
          largest,
          Math.hypot(
            (max[0] ?? 0) - (min[0] ?? 0),
            (max[1] ?? 0) - (min[1] ?? 0),
            (max[2] ?? 0) - (min[2] ?? 0),
          ),
        );
      } else if (shape.type === 'box') {
        largest = Math.max(largest, 2 * Math.hypot(...shape.halfExtents) + 2 * shape.radius);
      } else if (shape.type === 'sphere') {
        largest = Math.max(largest, 2 * shape.radius);
      } else if (shape.type === 'capsule' || shape.type === 'cylinder') {
        const [ax, ay, az] = shape.a;
        const [bx, by, bz] = shape.b;
        largest = Math.max(largest, Math.hypot(bx - ax, by - ay, bz - az) + 2 * shape.radius);
      }
    }
  }
  return largest;
}

if (import.meta.main) {
  const { Vfs: VfsClass } = await import('../src/vfs/vfs.ts');
  const { RecordDatabase: Db } = await import('../src/world/record-db.ts');
  const { openGameFolder } = await import('./gamedata-path.ts');
  const args = process.argv.slice(2);
  const secondsAt = args.indexOf('--seconds');
  const seconds = secondsAt >= 0 ? Number(args[secondsAt + 1]) : 5;
  const query = (
    args.find((_, i) => secondsAt < 0 || (i !== secondsAt && i !== secondsAt + 1)) ?? ''
  ).toLowerCase();
  const vfs = await VfsClass.mount(openGameFolder());
  const db = await Db.open(vfs);
  const matrix = await readCollisionMatrix(db);
  const collisions = new CollisionCache(vfs);
  const cells = (await db.interiorCells()).filter((cell) =>
    cell.editorId.toLowerCase().includes(query),
  );
  let settling = 0;
  let fell = 0;
  let lifted = 0;
  let droppedOff = 0;
  let cellsWithFalls = 0;
  const start = performance.now();
  for (const cell of cells) {
    const result = await settleCell(db, collisions, matrix, cell.formId, seconds);
    settling += result.settling;
    fell += result.fell.length;
    lifted += result.lifted.length;
    droppedOff += result.droppedOff;
    if (result.fell.length > 0) cellsWithFalls++;
    if (result.fell.length > 0 || result.lifted.length > 0) {
      console.log(`${cell.editorId} [${cell.formId.toString(16).toUpperCase()}]`);
      for (const object of result.fell) {
        console.log(
          `  ${object.reference.toString(16).toUpperCase().padStart(8, '0')} ${object.editorId} ${object.model} fell ${object.drop.toFixed(0)}`,
        );
      }
      for (const object of result.lifted) {
        console.log(
          `  ${object.reference.toString(16).toUpperCase().padStart(8, '0')} ${object.editorId} ${object.model} lifted ${object.rise.toFixed(0)}`,
        );
      }
    }
  }
  console.log(
    `${cells.length} cells, ${settling} objects settling, ${fell} fell through (in ${cellsWithFalls} cells), ${lifted} lifted, ${droppedOff} dropped off, ${((performance.now() - start) / 1000).toFixed(0)} s`,
  );
  await db.close();
  await vfs.close();
}
