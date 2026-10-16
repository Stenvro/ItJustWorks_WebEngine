// Walks the player up and down every staircase and ramp of the interior cells, as actors walk
// them: the slopes of the cells' navigation meshes (NAVM). Neighbouring navmesh triangles that
// slope the same way make one flight; where a flight meets flat navmesh at its foot and at its
// top, those are its landings. The player walks from a landing below to the landing above it
// (and back) along the flight's navmesh (through the middles of the edges its triangles share),
// steering as a player would, with the cell's collision placed as the viewers place it. Lists the walks that do not get there: where the player stopped, what they
// touched, the step ahead and the room above.
//
//   node tools/stairs-audit.ts                every interior cell
//   node tools/stairs-audit.ts <filter>       cells whose editor id contains <filter>
//   --verbose                                 also the walks that get there
//   --plain                                   steps on stairs only (no navmesh to step onto)

import { Layer } from '../src/physics/collision-layers.ts';
import type { PhysicsWorld } from '../src/physics/physics-world.ts';
import type { Vec3 } from '../src/render/math.ts';
import type { Player } from '../src/shell/player.ts';
import { loadCellData, type CellData } from '../src/world/cell-loader.ts';
import {
  navmeshTriangle,
  NavmeshFlag,
  NAVMESH_TOLERANCE,
  NavmeshSurface,
  parseNavmesh,
  triangleNeighbour,
  type Navmesh,
} from '../src/world/navmesh.ts';
import { PlayWorld } from './play-world.ts';

/** A navmesh triangle rising at least this much per unit along slopes (rise over run). */
const MIN_SLOPE = 0.25;
/** Neighbouring triangles of one flight slope this much the same way (cosine). */
const SAME_WAY = 0.85;
/** A flight rises at least this much (game units): lower ones are thresholds and rugs. */
const MIN_RISE = 24;
/** A landing lies this close to its end of the flight's height. */
const LANDING = 12;
/** The walk starts (ends) this far into the landing from the flight's edge. */
const INTO_LANDING = 40;
/** Arrived: this close to the end point, across and in height. */
const ARRIVED = 30;
/** A point of the way through a flight is passed this close (game units). */
const WAYPOINT = 24;
/** Walks per flight and way: across its width. */
const LANES = 3;
/** Walking speed assumed for the time a walk may take (running is faster). */
const SPEED = 200;

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
/** Without steps off the stairs (to compare). */
const plain = args.includes('--plain');
const filter = (args.find((arg) => !arg.startsWith('--')) ?? '').toLowerCase();
const round = (v: number): string => v.toFixed(0);
const hex = (id: number): string => id.toString(16).padStart(8, '0');

const game = await PlayWorld.open();
const { db } = game;

/** Where a flight meets a landing: the middle of their shared edge. */
interface Landing {
  readonly point: Vec3;
  /** Along the flight's width. */
  readonly across: number;
  /** The flight's triangle at this landing. */
  readonly triangle: number;
}

/** A flight of stairs or a ramp with its landings below and above. */
interface Flight {
  readonly navmesh: Navmesh;
  /** Its triangles. */
  readonly members: ReadonlySet<number>;
  readonly up: Vec3;
  readonly height: readonly [number, number];
  readonly bottom: readonly Landing[];
  readonly top: readonly Landing[];
  /** A point in it (for the report). */
  readonly at: Vec3;
}

/** The triangles of the same mesh across a triangle's three edges (undefined: none, or a link). */
function localNeighbours(navmesh: Navmesh, index: number): (number | undefined)[] {
  return [0, 1, 2].map((edge) => {
    const across = triangleNeighbour(navmesh, index, edge);
    return typeof across === 'number' ? across : undefined;
  });
}

/** The way up a triangle slopes (unit, horizontal), if it slopes enough to be part of a flight. */
function slopeOf(navmesh: Navmesh, index: number): Vec3 | undefined {
  const triangle = navmesh.triangles[index];
  if (!triangle || (triangle.flags & NavmeshFlag.deleted) !== 0) return undefined;
  const [a, b, c] = navmeshTriangle(navmesh, index);
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
  let nx = e1[1] * e2[2] - e1[2] * e2[1];
  let ny = e1[2] * e2[0] - e1[0] * e2[2];
  let nz = e1[0] * e2[1] - e1[1] * e2[0];
  if (nz < 0) [nx, ny, nz] = [-nx, -ny, -nz];
  const horizontal = Math.hypot(nx, ny);
  if (nz < 1e-6 || horizontal / nz < MIN_SLOPE) return undefined;
  return [-nx / horizontal, -ny / horizontal, 0];
}

/** The flights of a navigation mesh, each with landings at both ends. */
function flightsOf(navmesh: Navmesh): Flight[] {
  const count = navmesh.triangles.length;
  const ways = Array.from({ length: count }, (_, i) => slopeOf(navmesh, i));
  const flights: Flight[] = [];
  const seen = new Uint8Array(count);
  for (let start = 0; start < count; start++) {
    const way = ways[start];
    if (!way || seen[start]) continue;
    // Grow the flight over neighbours sloping the same way.
    const members: number[] = [];
    const queue = [start];
    seen[start] = 1;
    while (queue.length > 0) {
      const i = queue.pop() ?? 0;
      members.push(i);
      for (const next of localNeighbours(navmesh, i)) {
        if (next === undefined) continue;
        const nextWay = ways[next];
        if (seen[next] || !nextWay) continue;
        if (nextWay[0] * way[0] + nextWay[1] * way[1] < SAME_WAY) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }
    const flight = flightOf(navmesh, members, ways);
    if (flight) flights.push(flight);
  }
  return flights;
}

/** A flight from its triangles: its way up, height and landings; undefined without both. */
function flightOf(
  navmesh: Navmesh,
  members: readonly number[],
  ways: readonly (Vec3 | undefined)[],
): Flight | undefined {
  const inFlight = new Set(members);
  const points = members.flatMap((i) => navmeshTriangle(navmesh, i));
  // The way up: the members' ways, weighted alike.
  let ux = 0;
  let uy = 0;
  for (const i of members) {
    ux += ways[i]?.[0] ?? 0;
    uy += ways[i]?.[1] ?? 0;
  }
  const length = Math.hypot(ux, uy);
  if (length < 1e-6) return undefined;
  const up: Vec3 = [ux / length, uy / length, 0];
  const side: Vec3 = [-up[1], up[0], 0];
  let low = Infinity;
  let high = -Infinity;
  for (const [, , z] of points) {
    low = Math.min(low, z);
    high = Math.max(high, z);
  }
  if (high - low < MIN_RISE) return undefined;
  // Landings: flat neighbours at the flight's foot and top.
  const bottom: Landing[] = [];
  const top: Landing[] = [];
  for (const i of members) {
    const corners = navmeshTriangle(navmesh, i);
    localNeighbours(navmesh, i).forEach((next, edge) => {
      if (next === undefined || inFlight.has(next) || ways[next]) return;
      const a = corners[edge];
      const b = corners[(edge + 1) % 3];
      if (!a || !b) return;
      const point: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      const landing = { point, across: point[0] * side[0] + point[1] * side[1], triangle: i };
      if (point[2] <= low + LANDING) bottom.push(landing);
      else if (point[2] >= high - LANDING) top.push(landing);
    });
  }
  if (bottom.length === 0 || top.length === 0) return undefined;
  const n = points.length;
  const at: [number, number, number] = [0, 0, 0];
  for (const p of points) for (let k = 0; k < 3; k++) at[k] = (at[k] ?? 0) + (p[k] ?? 0) / n;
  return { navmesh, members: inFlight, up, height: [low, high], bottom, top, at };
}

/** Up to LANES landings spread across the flight's width. */
function spread(landings: readonly Landing[]): Landing[] {
  const sorted = [...landings].sort((a, b) => a.across - b.across);
  if (sorted.length <= LANES) return sorted;
  return Array.from(
    { length: LANES },
    (_, i) => sorted[Math.round((i * (sorted.length - 1)) / (LANES - 1))],
  ).filter((landing): landing is Landing => landing !== undefined);
}

interface Walk {
  readonly arrived: boolean;
  readonly detail: string;
}

/**
 * The way through a flight from one of its triangles to another: the middles of the edges the
 * triangles on the way share (fewest triangles first).
 */
function waypoints(flight: Flight, from: number, to: number): Vec3[] {
  const { navmesh, members } = flight;
  const previous = new Map<number, number>([[from, from]]);
  const queue = [from];
  while (queue.length > 0 && !previous.has(to)) {
    const i = queue.shift() ?? 0;
    for (const next of localNeighbours(navmesh, i)) {
      if (next === undefined || !members.has(next) || previous.has(next)) continue;
      previous.set(next, i);
      queue.push(next);
    }
  }
  const path: number[] = [];
  for (let i = to; previous.has(i) && i !== from; i = previous.get(i) ?? from) path.unshift(i);
  path.unshift(from);
  const points: Vec3[] = [];
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1] ?? 0;
    const b = path[k] ?? 0;
    const edge = localNeighbours(navmesh, a).indexOf(b);
    if (edge < 0) continue;
    const corners = navmeshTriangle(navmesh, a);
    const p = corners[edge];
    const q = corners[(edge + 1) % 3];
    if (p && q) points.push([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2]);
  }
  return points;
}

/** Walks the player from one landing to another, steering at it; undefined if it cannot start. */
function walk(
  physics: PhysicsWorld,
  player: Player,
  flight: Flight,
  from: Landing,
  to: Landing,
  climbing: boolean,
  nameOf: (collider: Parameters<PhysicsWorld['ownerOf']>[0]) => string,
): Walk | undefined {
  const sign = climbing ? 1 : -1;
  const { up } = flight;
  const start: Vec3 = [
    from.point[0] - up[0] * sign * INTO_LANDING,
    from.point[1] - up[1] * sign * INTO_LANDING,
    from.point[2],
  ];
  const end: Vec3 = [
    to.point[0] + up[0] * sign * INTO_LANDING,
    to.point[1] + up[1] * sign * INTO_LANDING,
    to.point[2],
  ];
  const floor = player.arrivalFloor(start);
  // No floor where the walk would start (navmesh over something the player cannot stand on).
  if (!floor || Math.abs(floor.height - start[2]) > ARRIVED) return undefined;
  // Through the flight's navmesh, then on to the end.
  const route = [from.point, ...waypoints(flight, from.triangle, to.triangle), end];
  let next = 0;
  const steer = (): void => {
    const [px, py] = player.feet;
    // On to the next point once this one is reached (the end must be reached itself).
    while (next < route.length - 1) {
      const point = route[next];
      if (!point || Math.hypot(point[0] - px, point[1] - py) > WAYPOINT) break;
      next++;
    }
    const target = route[next] ?? end;
    player.yaw = Math.atan2(target[0] - px, target[1] - py);
  };
  player.teleport([start[0], start[1], floor.height]);
  steer();
  player.pitch = 0;
  player.character.recover();
  for (let t = 0; t < 10; t++) player.update(1 / 60);
  let distance = 0;
  let last: Vec3 = start;
  for (const point of route) {
    distance += Math.hypot(point[0] - last[0], point[1] - last[1]);
    last = point;
  }
  let arrived = false;
  player.press('Forward', true);
  for (let t = 0; t < (distance / SPEED + 1.5) * 60 && !arrived; t++) {
    steer();
    player.update(1 / 60);
    const [px, py, pz] = player.feet;
    arrived = Math.hypot(end[0] - px, end[1] - py) < ARRIVED && Math.abs(end[2] - pz) < ARRIVED;
  }
  player.press('Forward', false);
  const [fx, fy, fz] = player.feet;
  const along = Math.hypot(fx - start[0], fy - start[1]);
  const detail =
    `${climbing ? 'up' : 'down'} at ${round(start[0])},${round(start[1])},${round(start[2])}` +
    ` to ${round(end[0])},${round(end[1])},${round(end[2])}: ` +
    (arrived
      ? 'arrived'
      : `stopped ${round(along)} of ${round(distance)} along, ` +
        `${round(fz - flight.height[0])} of ${round(flight.height[1] - flight.height[0])} up` +
        stopReport(physics, player, flight, sign, nameOf));
  return { arrived, detail };
}

/** Where a walk stopped: the step ahead, the room above, what the player touches. */
function stopReport(
  physics: PhysicsWorld,
  player: Player,
  flight: Flight,
  sign: number,
  nameOf: (collider: Parameters<PhysicsWorld['ownerOf']>[0]) => string,
): string {
  const [fx, fy, fz] = player.feet;
  const own = player.character.collider;
  const ahead = physics.raycast(
    [fx + flight.up[0] * sign * 30, fy + flight.up[1] * sign * 30, fz + 80],
    [0, 0, -1],
    200,
    Layer.charController,
    own,
  );
  const above = physics.raycast([fx, fy, fz + 1], [0, 0, 1], 400, Layer.charController, own);
  const touched = [...new Set(player.character.touched.map((collider) => nameOf(collider)))];
  return (
    ` · step ahead ${ahead ? round(ahead.point[2] - fz) : '—'}` +
    ` · headroom ${above ? round(above.distance + 1) : '—'}` +
    ` · touching ${touched.join(', ') || 'nothing'}`
  );
}

let flightsTested = 0;
let walks = 0;
let failed = 0;
const failedByObject = new Map<string, number>();

async function auditCell(editorId: string, cell: number, data: CellData): Promise<void> {
  const flights: Flight[] = [];
  const meshes: Navmesh[] = [];
  for (const id of db.cellReferences(cell)) {
    const location = db.locate(id);
    if (!location || db.typeAt(location) !== 'NAVM') continue;
    const record = await db.get(id);
    if (!record || record.deleted) continue;
    const navmesh = parseNavmesh(record);
    if (!navmesh) continue;
    meshes.push(navmesh);
    flights.push(...flightsOf(navmesh));
  }
  if (flights.length === 0) return;
  const physics = game.newPhysics();
  try {
    const isEnabled = await game.enabledIn(data, true);
    const { names } = await game.placeCell(physics, data, isEnabled);
    physics.step(1 / 60);
    const player = game.newPlayer(physics, () => undefined);
    // Steps off the stairs where actors walk, as the viewers let the player take them.
    if (!plain) {
      const surface = new NavmeshSurface(meshes);
      player.character.walkable = (x, y, z) =>
        surface.heightNear(x, y, z, NAVMESH_TOLERANCE) !== undefined;
    }
    const nameOf = (collider: Parameters<PhysicsWorld['ownerOf']>[0]): string => {
      const reference = physics.ownerOf(collider)?.reference ?? 0;
      return `${names.get(reference) ?? '?'} ${hex(reference)}`;
    };
    const nearest = (landings: readonly Landing[], across: number): Landing | undefined =>
      [...landings].sort((a, b) => Math.abs(a.across - across) - Math.abs(b.across - across))[0];
    for (const flight of flights) {
      const results: Walk[] = [];
      for (const [starts, ends, climbing] of [
        [flight.bottom, flight.top, true],
        [flight.top, flight.bottom, false],
      ] as const) {
        for (const from of spread(starts)) {
          const to = nearest(ends, from.across);
          const result = to && walk(physics, player, flight, from, to, climbing, nameOf);
          if (!result) continue;
          walks++;
          results.push(result);
          if (result.arrived) continue;
          failed++;
          for (const name of /touching (.*)$/.exec(result.detail)?.[1]?.split(', ') ?? []) {
            const object = name.replace(/ [0-9a-f]{8}$/, '');
            failedByObject.set(object, (failedByObject.get(object) ?? 0) + 1);
          }
        }
      }
      if (results.length === 0) continue;
      flightsTested++;
      const bad = results.filter((result) => !result.arrived);
      if (bad.length === 0 && !verbose) continue;
      const [x, y, z] = flight.at;
      console.log(
        `${editorId} flight at ${round(x)},${round(y)},${round(z)}: ` +
          `${round(flight.height[1] - flight.height[0])} up`,
      );
      for (const result of verbose ? results : bad) console.log(`    ${result.detail}`);
    }
    player.free();
  } catch (error) {
    console.log(`${editorId}: ${String(error).split('\n')[0] ?? ''}`);
  }
  physics.free();
}

for (const cell of await db.interiorCells()) {
  if (filter !== '' && !cell.editorId.toLowerCase().includes(filter)) continue;
  let data: CellData;
  try {
    data = await loadCellData(db, cell.formId);
  } catch {
    continue;
  }
  await auditCell(cell.editorId, cell.formId, data);
}

console.log(
  `\n${String(flightsTested)} flights, ${String(walks)} walks, ${String(failed)} did not get there`,
);
console.log('touched where the player stopped:');
for (const [object, count] of [...failedByObject].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
  console.log(`  ${String(count).padStart(5)}  ${object}`);
}
