// Walks the player through every load door. Each door's arrival point (the XTEL of the door on
// the other side) gets the collision of where it leads, placed as the viewers place it: the
// interior cell (player homes bought and built, as the viewer opens them), or the 3×3
// exterior cells around it with their landscape. The player arrives as through the door (onto
// its floor, Player.arrivalFloor), stands for a second, then walks off in eight directions. Lists the arrivals without a floor, where the player
// falls, stands inside something, finds no headroom, cannot move, or is under water. Also
// where the finders start the player: the first door's arrival of an interior (its middle
// without a door), and a worldspace's door nearest its busiest cell (that cell's middle,
// on whatever is below, without doors and map markers).
//
//   node tools/spawn-audit.ts                  every door (interior cells, then the worldspaces)
//   node tools/spawn-audit.ts <filter>         destinations whose editor id contains <filter>
//   node tools/spawn-audit.ts --door <formid>  one door's arrival in detail (hex form id)
//   --verbose                                  also the arrivals without problems
//   --passages [filter]                        instead: opens every door of the interior cells
//                                              that opens (its Open sequence) and walks the
//                                              player through it both ways

import RAPIER from '@dimforge/rapier3d-compat';
import { parseNif } from '../src/formats/nif/nif.ts';
import {
  buildCollision,
  HAVOK_SCALE,
  type CollisionBody,
  type CollisionData,
} from '../src/physics/collision-data.ts';
import { Layer, readCollisionMatrix } from '../src/physics/collision-layers.ts';
import { landscapeMesh } from '../src/physics/landscape.ts';
import {
  GRAVITY,
  initPhysics,
  PhysicsWorld,
  type PlacedCollision,
} from '../src/physics/physics-world.ts';
import { objectWorld, playSequence, type ModelSequences } from '../src/render/animation.ts';
import { invert } from '../src/render/frustum.ts';
import { multiply, transformPoint, type Mat4, type Vec3 } from '../src/render/math.ts';
import { buildModel } from '../src/render/model-data.ts';
import { Player, readPlayerData, type PlayerData } from '../src/shell/player.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { cellArrival, loadCellData, type CellData } from '../src/world/cell-loader.ts';
import { enabledAtGameStart, parseTeleport } from '../src/world/cell-records.ts';
import { enabledReferences, findToggles, gameStartSelection } from '../src/world/cell-upgrades.ts';
import {
  findHomeActions,
  fullyUpgraded,
  NEW_GAME,
  playHomeActions,
  ScriptEnvironment,
} from '../src/world/player-home.ts';
import { GameSettings } from '../src/world/game-settings.ts';
import { CELL_SIZE, LAND_GRID } from '../src/world/land.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { cellWater } from '../src/world/water.ts';
import { waterAreaHeight } from '../src/audio/water-audio.ts';
import { Worldspace } from '../src/world/worldspace.ts';
import { openGameFolder } from './gamedata-path.ts';

/** Standing this long after arriving; walking this long in each direction (seconds). */
const STAND_SECONDS = 1;
const WALK_SECONDS = 0.75;
/** Sinking further than this while standing: the player falls (game units). */
const FALL = 48;
/** Moving less than this in every direction: stuck (game units). */
const STUCK = 16;
/** The shape is tested this much above the floor, clear of the floor it stands on. */
const CLEARANCE = 2;
/** SWIM_SUBMERSION in Player: deeper than this share of the body swims. */
const SWIM_SUBMERSION = 0.69;
/** Passages: walking from this far on one side of a door (game units) for this long. */
const PASSAGE_START = 100;
const PASSAGE_SECONDS = 1.5;
/** Passages: the door's other side is reached this far beyond it. */
const PASSAGE_PAST = 60;

const args = process.argv.slice(2);
const doorArg = args.indexOf('--door');
const onlyDoor = doorArg >= 0 ? Number.parseInt(args[doorArg + 1] ?? '', 16) : undefined;
const verbose = args.includes('--verbose');
const passages = args.includes('--passages');
const filter = (
  doorArg >= 0 ? '' : (args.find((arg) => !arg.startsWith('--')) ?? '')
).toLowerCase();
const hex = (id: number): string => id.toString(16).padStart(8, '0');
const round = (v: number): string => v.toFixed(0);

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
await initPhysics();
const matrix = await readCollisionMatrix(db);
const playerData: PlayerData = await readPlayerData(
  db,
  vfs,
  await GameSettings.read(db),
  async (path) => parseNif(await vfs.read(path)),
);

const collisions = new Map<string, Promise<CollisionData | undefined>>();
function collisionOf(path: string): Promise<CollisionData | undefined> {
  let pending = collisions.get(path);
  if (!pending) {
    pending = (async () => {
      if (path === '' || !vfs.has(path)) return undefined;
      try {
        const collision = buildCollision(parseNif(await vfs.read(path)));
        return collision.bodies.length > 0 ? collision : undefined;
      } catch {
        return undefined;
      }
    })();
    collisions.set(path, pending);
  }
  return pending;
}

const scripts = await ScriptEnvironment.create(db, vfs);

/**
 * Which references are enabled: as at the start of a new game, with player homes bought and
 * built (the interior viewer's default; their markers follow the scripts).
 */
async function enabledIn(data: CellData, homes: boolean): Promise<(reference: number) => boolean> {
  if (!homes) {
    const toggles = findToggles(data);
    return enabledReferences(data, toggles, gameStartSelection(toggles));
  }
  const actions = await findHomeActions(scripts, data);
  const scripted =
    actions.purchases.length > 0 || actions.house
      ? (await playHomeActions(scripts, actions, fullyUpgraded(actions, NEW_GAME))).enabled
      : new Map<number, boolean>();
  const toggles = findToggles(data, actions.controlled);
  return enabledReferences(data, toggles, gameStartSelection(toggles), scripted);
}

/** Places a cell's enabled objects and primitives (and its landscape) as PlaySession does. */
async function placeCell(
  physics: PhysicsWorld,
  data: CellData,
  isEnabled: (reference: number) => boolean,
  land?: { readonly data: Parameters<typeof landscapeMesh>[0]; x: number; y: number },
): Promise<{ placed: PlacedCollision[]; names: Map<number, string> }> {
  const placed: PlacedCollision[] = [];
  const names = new Map<number, string>();
  if (land) {
    const { vertices, indices } = landscapeMesh(land.data, land.x, land.y);
    placed.push(
      physics.addMesh(vertices, indices, Layer.ground, { reference: 0, kind: 'landscape' }),
    );
  }
  const objects = data.objects.filter((object) => isEnabled(object.reference));
  const loaded = await Promise.all(objects.map((object) => collisionOf(object.model)));
  objects.forEach((object, i) => {
    const collision = loaded[i];
    if (!collision) return;
    const one = physics.addObject(
      collision,
      object.world,
      { reference: object.reference, kind: 'object' },
      false,
    );
    placed.push(one);
    names.set(object.reference, object.editorId !== '' ? object.editorId : object.model);
    if (object.dontHavokSettle !== true && one.dynamic) physics.settle(one);
  });
  for (const primitive of data.primitives) {
    if (!isEnabled(primitive.reference)) continue;
    placed.push(
      physics.addPrimitive(primitive.shape, primitive.bounds, primitive.world, primitive.layer, {
        reference: primitive.reference,
        kind: 'object',
      }),
    );
    names.set(primitive.reference, `collision ${primitive.shape}`);
  }
  return { placed, names };
}

/** A door's arrival: where the player comes in, through which door, from where. */
interface Arrival {
  /** The door in the destination the player comes out of (0: the finder's start). */
  readonly door: number;
  /** The door walked through (on the other side). */
  readonly from: number;
  readonly position: Vec3;
  readonly heading: number;
  /** Not through a door: placed on whatever is below, searching from this much higher. */
  readonly searchAbove?: number;
}

interface Result {
  readonly problems: string[];
  readonly detail: string;
}

/** Runs one arrival in a physics world holding the destination's collision. */
function tryArrival(
  physics: PhysicsWorld,
  player: Player,
  arrival: Arrival,
  waterHeight: number | undefined,
  names: ReadonlyMap<number, string>,
): Result {
  // Queries see what was placed only after a step (Rapier updates its broad phase there).
  physics.step(1 / 60);
  const problems: string[] = [];
  const own = player.character.collider;
  const [x, y, z] = arrival.position;
  const nameOf = (reference: number | undefined): string =>
    reference === undefined || reference === 0
      ? 'landscape'
      : `${names.get(reference) ?? '?'} ${hex(reference)}`;
  // The floor, as PlaySession finds it.
  const search = arrival.searchAbove;
  const hit =
    search === undefined
      ? undefined
      : physics.raycast([x, y, z + search], [0, 0, -1], search + 65536, Layer.charController, own);
  const floor =
    search === undefined
      ? player.arrivalFloor([x, y, z])
      : hit && { height: hit.point[2], owner: hit.owner?.reference ?? 0 };
  const standZ = floor?.height ?? z;
  let noFloor: string | undefined;
  if (!floor) {
    const far = physics.raycast([x, y, z], [0, 0, -1], 65536, Layer.charController, own);
    noFloor = far
      ? `no floor (next surface ${round(z - far.point[2])} below: ${nameOf(far.owner?.reference)})`
      : 'no floor (nothing below)';
  }
  player.teleport([x, y, standZ], arrival.heading);
  player.pitch = 0;
  // Out of what the player stands in, as PlaySession places them.
  player.character.recover();
  const [rx, ry, rz] = player.feet;
  const recovered = Math.hypot(rx - x, ry - y, rz - standZ);
  // What the shape stands in, just above the floor.
  const shape = player.character.shape;
  const overlaps = new Set<string>();
  const centre = {
    x: rx / HAVOK_SCALE,
    y: ry / HAVOK_SCALE,
    z: (rz + CLEARANCE + shape.height / 2) / HAVOK_SCALE,
  };
  const charFilter = physics.filterFor(Layer.charController);
  physics.world.intersectionsWithShape(
    centre,
    { x: 0, y: 0, z: 0, w: 1 },
    own.shape,
    (collider) => {
      overlaps.add(nameOf(physics.ownerOf(collider)?.reference));
      return true;
    },
    RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
    undefined,
    own,
    undefined,
    (collider) => charFilter(collider),
  );
  if (overlaps.size > 0) problems.push(`stands in ${[...overlaps].join(', ')}`);
  // Headroom: what is above the feet within the body's height.
  const ceiling = physics.raycast(
    [rx, ry, rz + 1],
    [0, 0, 1],
    shape.height,
    Layer.charController,
    own,
  );
  if (ceiling && ceiling.distance + 1 < shape.height) {
    problems.push(
      `ceiling ${round(ceiling.distance + 1)} above the feet (${nameOf(ceiling.owner?.reference)})`,
    );
  }
  if (waterHeight !== undefined && waterHeight - rz >= SWIM_SUBMERSION * shape.height) {
    problems.push(`under water (${round(waterHeight - rz)} deep)`);
  }
  // Standing.
  for (let t = 0; t < STAND_SECONDS * 60; t++) player.update(1 / 60);
  const settled = player.feet;
  const sank = rz - settled[2];
  // Arriving in water (an underwater passage's auto-load door) needs no floor, and sinking
  // into it to swim is no fall.
  if (noFloor !== undefined && !player.swimming) problems.unshift(noFloor);
  if (sank > FALL && !player.swimming)
    problems.push(`falls (${round(sank)} in ${String(STAND_SECONDS)} s)`);
  // Walking off in eight directions from where the player stands.
  const start: Vec3 = [...settled];
  const moves: number[] = [];
  for (let i = 0; i < 8; i++) {
    player.teleport(start, arrival.heading + (i * Math.PI) / 4);
    player.press('Forward', true);
    for (let t = 0; t < WALK_SECONDS * 60; t++) player.update(1 / 60);
    player.press('Forward', false);
    for (let t = 0; t < 6; t++) player.update(1 / 60);
    const [fx, fy] = player.feet;
    moves.push(Math.hypot(fx - start[0], fy - start[1]));
  }
  if (Math.max(...moves) < STUCK) problems.push('stuck (cannot move)');
  else if ((moves[0] ?? 0) < STUCK) problems.push('blocked ahead');
  const detail =
    `at ${round(x)},${round(y)},${round(z)} · floor ${floor ? `${round(standZ - z)} (${nameOf(floor.owner)})` : '—'} · ` +
    `moves ${moves.map(round).join('/')}` +
    (recovered > 1 ? ` · pushed out ${round(recovered)}` : '');
  return { problems, detail };
}

function newPlayer(
  physics: PhysicsWorld,
  water: (x: number, y: number) => number | undefined,
): Player {
  return new Player({ ...playerData, physics, waterHeight: water }, [0, 0, 0], 0);
}

let disabledDoors = 0;

const samePlace = (a: readonly number[], b: readonly number[] | undefined): boolean =>
  b !== undefined && Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0)) < 1;

/** The arrivals into a set of doors: each door's partner's XTEL. */
async function arrivalsInto(doors: readonly number[]): Promise<Arrival[]> {
  const arrivals: Arrival[] = [];
  for (const door of doors) {
    if (onlyDoor !== undefined && door !== onlyDoor) continue;
    const own = await db.get(door);
    const there = own && parseTeleport(own);
    if (!there) continue;
    const other = await db.get(there.door);
    const back = other && parseTeleport(other);
    // The other door's XTEL is where one arrives here (if it leads back to this door).
    if (back?.door !== door) continue;
    // Doors not there at the start of a new game (on either side) are left out.
    if (!(await enabledAtGameStart(db, door)) || !(await enabledAtGameStart(db, there.door))) {
      disabledDoors++;
      continue;
    }
    arrivals.push({ door, from: there.door, position: back.position, heading: back.rotation[2] });
  }
  return arrivals;
}

const cellNames = new Map<number, string>();
async function cellName(cell: number | undefined): Promise<string> {
  if (cell === undefined) return '?';
  let name = cellNames.get(cell);
  if (name === undefined) {
    const record = await db.get(cell);
    const world = db.worldOfCell(cell);
    name =
      record?.editorId ??
      (world === undefined ? hex(cell) : ((await db.get(world))?.editorId ?? hex(cell)));
    if (name === '' && world !== undefined) name = (await db.get(world))?.editorId ?? hex(cell);
    cellNames.set(cell, name);
  }
  return name;
}

let tested = 0;
const byProblem = new Map<string, number>();
async function report(where: string, arrival: Arrival, result: Result): Promise<void> {
  tested++;
  const kinds = result.problems.map((problem) =>
    problem.replace(/ \(.*$/, '').replace(/^stands in .*/, 'stands in something'),
  );
  for (const kind of new Set(kinds)) byProblem.set(kind, (byProblem.get(kind) ?? 0) + 1);
  if (result.problems.length === 0 && onlyDoor === undefined && !verbose) return;
  const how =
    arrival.door === 0
      ? 'finder start'
      : `door ${hex(arrival.door)} (from ${await cellName(db.cellOfReference(arrival.from))})`;
  console.log(`${where} ${how}: ${result.problems.join('; ') || 'ok'}\n    ${result.detail}`);
}

// --- Door passages ----------------------------------------------------------------------------

/** A door model's sequences, and the middle of what it draws (its own frame). */
interface DoorModel {
  readonly sequences: ModelSequences | undefined;
  readonly center: Vec3;
}
const doorModels = new Map<string, Promise<DoorModel | undefined>>();
function doorModelOf(path: string): Promise<DoorModel | undefined> {
  let pending = doorModels.get(path);
  if (!pending) {
    pending = (async () => {
      try {
        const model = buildModel(parseNif(await vfs.read(path)));
        return { sequences: model.sequences, center: model.center };
      } catch {
        return undefined;
      }
    })();
    doorModels.set(path, pending);
  }
  return pending;
}

interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** The bounds of a door's moving bodies (its leaf) in the model's space, game units. */
function leafBounds(bodies: readonly CollisionBody[]): Bounds | undefined {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const add = (transform: Mat4, point: Vec3): void => {
    const [x, y, z] = transformPoint(transform, point);
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
    max[2] = Math.max(max[2], z);
  };
  for (const body of bodies) {
    if (body.motion !== 'keyframed') continue;
    for (const shape of body.shapes) {
      const points =
        shape.type === 'mesh' ? shape.vertices : shape.type === 'convex' ? shape.points : undefined;
      if (points) {
        for (let i = 0; i + 2 < points.length; i += 3) {
          add(body.transform, [points[i] ?? 0, points[i + 1] ?? 0, points[i + 2] ?? 0]);
        }
      } else if (shape.type === 'box') {
        const [hx, hy, hz] = shape.halfExtents;
        for (const sx of [-1, 1]) {
          for (const sy of [-1, 1]) {
            for (const sz of [-1, 1]) {
              add(body.transform, transformPoint(shape.transform, [sx * hx, sy * hy, sz * hz]));
            }
          }
        }
      }
    }
  }
  return min[0] <= max[0] ? { min, max } : undefined;
}

let doorsWalked = 0;
let doorsBlocked = 0;

/**
 * Opens every enabled door of a cell that opens (its keyframed bodies to the end of the Open
 * sequence, as PlaySession moves them) and walks the player through it from both sides: from
 * PASSAGE_START in front along the door's local Y axis (doors stand in their XZ plane).
 */
async function walkThroughDoors(
  where: string,
  data: CellData,
  isEnabled: (reference: number) => boolean,
  physics: PhysicsWorld,
  player: Player,
  placed: readonly PlacedCollision[],
  names: ReadonlyMap<number, string>,
): Promise<void> {
  const byReference = new Map(placed.map((one) => [one.owner.reference, one]));
  const doors = data.objects.filter(
    (object) => object.baseType === 'DOOR' && !object.teleport && isEnabled(object.reference),
  );
  // Open them all first: a door's way may lead through another.
  const open: { readonly door: (typeof doors)[number]; readonly leaf: Bounds }[] = [];
  for (const door of doors) {
    const one = byReference.get(door.reference);
    const model = await doorModelOf(door.model);
    const sequences = model?.sequences;
    const sequence = sequences?.byName.get('open');
    if (!one || !model || !sequences || !sequence) continue;
    const frame = playSequence(sequences, { sequence: 'open', start: 0 }, sequence.duration + 0.01);
    for (const body of one.bodies) {
      if (body.data.motion !== 'keyframed') continue;
      const node = sequences.objects.get(body.data.node);
      if (node === undefined) continue;
      const rest = objectWorld(sequences, undefined, node);
      const moved = objectWorld(sequences, frame, node);
      const restInverse = rest && invert(rest);
      if (!moved || !restInverse) continue;
      physics.moveBody(
        one,
        body,
        multiply(multiply(moved, restInverse), body.data.transform),
        door.world,
      );
    }
    const leaf = leafBounds(one.bodies.map(({ data }) => data));
    // A door to walk through: its leaf stands taller than the player (not a display case's
    // lid, a shackle or a trapdoor).
    if (leaf && leaf.max[2] - leaf.min[2] >= player.character.shape.height)
      open.push({ door, leaf });
  }
  physics.step(1 / 60);
  physics.step(1 / 60);
  const own = player.character.collider;
  const nameOf = (reference: number | undefined): string =>
    reference === undefined || reference === 0
      ? 'landscape'
      : `${names.get(reference) ?? '?'} ${hex(reference)}`;
  for (const { door, leaf } of open) {
    const w = door.world;
    const scale = Math.hypot(w[0] ?? 0, w[1] ?? 0, w[2] ?? 0) || 1;
    // Through the middle of the closed leaf, across its thin side.
    const thinX = leaf.max[0] - leaf.min[0] < leaf.max[1] - leaf.min[1];
    const axis: Vec3 = thinX
      ? [(w[0] ?? 0) / scale, (w[1] ?? 0) / scale, (w[2] ?? 0) / scale]
      : [(w[4] ?? 0) / scale, (w[5] ?? 0) / scale, (w[6] ?? 0) / scale];
    const cx = (leaf.min[0] + leaf.max[0]) / 2;
    const cy = (leaf.min[1] + leaf.max[1]) / 2;
    const origin: Vec3 = [
      (w[12] ?? 0) + (w[0] ?? 0) * cx + (w[4] ?? 0) * cy,
      (w[13] ?? 0) + (w[1] ?? 0) * cx + (w[5] ?? 0) * cy,
      w[14] ?? 0,
    ];
    const results: string[] = [];
    let blocked = false;
    for (const side of [-1, 1]) {
      const from: Vec3 = [
        origin[0] + axis[0] * side * PASSAGE_START,
        origin[1] + axis[1] * side * PASSAGE_START,
        origin[2],
      ];
      const floor = player.arrivalFloor(from);
      if (!floor) {
        results.push(`${side < 0 ? 'front' : 'back'}: no floor`);
        continue;
      }
      player.teleport(
        [from[0], from[1], floor.height],
        Math.atan2(-side * axis[0], -side * axis[1]),
      );
      player.press('Forward', true);
      for (let t = 0; t < PASSAGE_SECONDS * 60; t++) player.update(1 / 60);
      player.press('Forward', false);
      const feet = player.feet;
      const past = -side * ((feet[0] - origin[0]) * axis[0] + (feet[1] - origin[1]) * axis[1]);
      if (past >= PASSAGE_PAST) {
        results.push(`${side < 0 ? 'front' : 'back'}: through`);
        continue;
      }
      blocked = true;
      const touched = [
        ...new Set(player.character.touched.map((c) => nameOf(physics.ownerOf(c)?.reference))),
      ];
      // What is above the player where they stopped (a low lintel).
      const ceiling = physics.raycast(
        [feet[0], feet[1], feet[2] + 1],
        [0, 0, 1],
        400,
        Layer.charController,
        own,
      );
      results.push(
        `${side < 0 ? 'front' : 'back'}: stopped ${round(past)} past it, touching ${touched.join(', ') || 'nothing'}` +
          (ceiling
            ? ` (headroom ${round(ceiling.distance + 1)}: ${nameOf(ceiling.owner?.reference)})`
            : ''),
      );
    }
    doorsWalked++;
    if (blocked) doorsBlocked++;
    if (blocked || verbose) {
      console.log(`${where} door ${hex(door.reference)} ${door.editorId}: ${results.join('; ')}`);
    }
  }
}

// --- Interior cells ---------------------------------------------------------------------------

const interiors = (await db.interiorCells()).filter(
  (cell) => filter === '' || cell.editorId.toLowerCase().includes(filter),
);
for (const cell of interiors) {
  let data: CellData;
  try {
    data = await loadCellData(db, cell.formId);
  } catch (error) {
    console.log(`${cell.editorId}: cell does not load: ${String(error)}`);
    continue;
  }
  const doors = data.objects.flatMap((object) => (object.teleport ? [object.reference] : []));
  const arrivals = await arrivalsInto(doors);
  if (onlyDoor === undefined) {
    // The interior viewer's start: as through the first door, else the cell's middle.
    const start = await cellArrival(db, data);
    const covered = arrivals.some((arrival) => samePlace(arrival.position, start?.position));
    if (!covered) {
      arrivals.push(
        start
          ? { door: 0, from: 0, position: [...start.position], heading: start.heading }
          : { door: 0, from: 0, position: [...data.entrance], heading: 0, searchAbove: 64 },
      );
    }
  }
  if (arrivals.length === 0 && !passages) continue;
  const physics = new PhysicsWorld(matrix, GRAVITY);
  try {
    const isEnabled = await enabledIn(data, true);
    const { placed, names } = await placeCell(physics, data, isEnabled);
    if (passages) {
      const player = newPlayer(physics, () => undefined);
      await walkThroughDoors(cell.editorId, data, isEnabled, physics, player, placed, names);
      player.free();
      physics.free();
      continue;
    }
    // Interiors' water is placed: the water activators' surfaces.
    const waterAt = (x: number, y: number): number | undefined => {
      for (const area of data.waterAreas) {
        if (!isEnabled(area.reference)) continue;
        const height = waterAreaHeight(area, x, y);
        if (height !== undefined) return height;
      }
      return undefined;
    };
    const player = newPlayer(physics, waterAt);
    for (const arrival of arrivals) {
      const [x, y] = arrival.position;
      await report(
        cell.editorId,
        arrival,
        tryArrival(physics, player, arrival, waterAt(x, y), names),
      );
    }
    player.free();
  } catch (error) {
    console.log(`${cell.editorId}: ${String(error).split('\n')[0] ?? ''}`);
  }
  physics.free();
}

// --- Worldspaces ----------------------------------------------------------------------------

for (const info of passages ? [] : await db.worldspaces()) {
  if (filter !== '' && !info.editorId.toLowerCase().includes(filter)) continue;
  const persistent = db.persistentCell(info.formId);
  const doors: number[] = [];
  for (const id of persistent === undefined ? [] : db.cellReferences(persistent)) {
    const record = await db.get(id);
    if (record && !record.deleted && record.type === 'REFR' && record.fields.has('XTEL'))
      doors.push(id);
  }
  const arrivals = await arrivalsInto(doors);
  const world = await Worldspace.open(db, info.formId);
  if (onlyDoor === undefined) {
    // The world viewer's start: the door nearest the busiest cell, else that cell's middle.
    const [tx, ty] = world.busiestCell() ?? [0, 0];
    const start = await world.arrivalNear((tx + 0.5) * CELL_SIZE, (ty + 0.5) * CELL_SIZE);
    if (!start) {
      const land = await world.land(tx, ty);
      const middle = Math.floor(LAND_GRID / 2);
      const ground = land?.heights[middle * LAND_GRID + middle];
      arrivals.push({
        door: 0,
        from: 0,
        position: [
          (tx + 0.5) * CELL_SIZE,
          (ty + 0.5) * CELL_SIZE,
          ground ?? world.landWorld.defaultLandHeight,
        ],
        heading: 0,
        searchAbove: 8192,
      });
    } else if (!arrivals.some((arrival) => samePlace(arrival.position, start.position))) {
      arrivals.push({ door: 0, from: 0, position: [...start.position], heading: start.heading });
    }
  }
  if (arrivals.length === 0) continue;
  const cellOf = (v: number): number => Math.floor(v / CELL_SIZE);
  arrivals.sort(
    (a, b) =>
      cellOf(a.position[0]) - cellOf(b.position[0]) ||
      cellOf(a.position[1]) - cellOf(b.position[1]),
  );
  const physics = new PhysicsWorld(matrix, GRAVITY);
  const loaded = new Map<
    string,
    { placed: PlacedCollision[]; names: Map<number, string>; water: number | undefined }
  >();
  const waterAt = (px: number, py: number): number | undefined =>
    loaded.get(`${String(cellOf(px))},${String(cellOf(py))}`)?.water;
  const player = newPlayer(physics, waterAt);
  for (const arrival of arrivals) {
    try {
      const cx = cellOf(arrival.position[0]);
      const cy = cellOf(arrival.position[1]);
      // The 3×3 cells around the arrival; the others go.
      for (const [key, cell] of loaded) {
        const [kx = 0, ky = 0] = key.split(',').map(Number);
        if (Math.max(Math.abs(kx - cx), Math.abs(ky - cy)) <= 1) continue;
        for (const placed of cell.placed) physics.remove(placed);
        loaded.delete(key);
      }
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const x = cx + dx;
          const y = cy + dy;
          const key = `${String(x)},${String(y)}`;
          if (loaded.has(key)) continue;
          const cellId = await world.cell(x, y);
          if (cellId === undefined) {
            loaded.set(key, { placed: [], names: new Map(), water: undefined });
            continue;
          }
          const data = await loadCellData(db, cellId, world.persistentReferences(x, y));
          const land = await world.land(x, y);
          const placed = await placeCell(
            physics,
            data,
            await enabledIn(data, false),
            land && { data: land, x, y },
          );
          const water = cellWater(data.cell, {
            height: world.defaultWaterHeight,
            type: world.waterWorld.water,
          });
          loaded.set(key, { ...placed, water: water?.height });
        }
      }
      const names = new Map<number, string>();
      for (const cell of loaded.values()) for (const [k, v] of cell.names) names.set(k, v);
      await report(
        info.editorId,
        arrival,
        tryArrival(
          physics,
          player,
          arrival,
          waterAt(arrival.position[0], arrival.position[1]),
          names,
        ),
      );
    } catch (error) {
      console.log(
        `${info.editorId} door ${hex(arrival.door)}: ${String(error).split('\n')[0] ?? ''}`,
      );
    }
  }
  player.free();
  physics.free();
}

if (passages) {
  console.log(`\n${String(doorsWalked)} doors walked through, ${String(doorsBlocked)} blocked`);
  process.exit(0);
}
console.log(
  `\n${String(tested)} arrivals tested (${String(disabledDoors)} disabled at the start left out)`,
);
for (const [problem, count] of [...byProblem].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(5)}  ${problem}`);
}
