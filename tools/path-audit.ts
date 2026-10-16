// Paths over the interiors' navigation meshes (src/ai/pathfinding.ts) against the real files:
// in every interior, a path from each door's navmesh triangle (the triangles the Creation Kit
// marks in front of doors) to each other one; what does not connect is listed with its cell.
//
//   node tools/path-audit.ts                 every interior cell
//   node tools/path-audit.ts Whiterun        interiors whose editor id starts so
//   node tools/path-audit.ts --list          also every pair that does not connect
//   node tools/path-audit.ts --radius 18     the actor's radius (default: a human's, 14 × 1.03)

import { findPath, type NavmeshSet } from '../src/ai/pathfinding.ts';
import {
  cellNavmeshes,
  NAVMESH_TOLERANCE,
  navmeshTriangle,
  NavmeshSurface,
  triangleNeighbour,
  type Navmesh,
} from '../src/world/navmesh.ts';
import { PlayWorld } from './play-world.ts';

const args = process.argv.slice(2);
const list = args.includes('--list');
const radiusAt = args.indexOf('--radius');
const radius = radiusAt >= 0 ? Number(args[radiusAt + 1]) : 14 * 1.03;
const prefix = args.find((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--radius');

type Vec3 = [number, number, number];

const game = await PlayWorld.open();
const cells = (await game.db.interiorCells()).filter(
  (cell) => prefix === undefined || cell.editorId.toLowerCase().startsWith(prefix.toLowerCase()),
);

/** The navmeshes of a cell as a set paths are searched over. */
function setOf(meshes: readonly Navmesh[]): NavmeshSet {
  const byId = new Map(meshes.map((mesh) => [mesh.formId, mesh]));
  const surface = new NavmeshSurface(meshes);
  return {
    navmesh: (formId) => byId.get(formId),
    locate: ([x, y, z]) => surface.near(x, y, z, NAVMESH_TOLERANCE),
  };
}

const centre = (mesh: Navmesh, triangle: number): Vec3 => {
  const [a, b, c] = navmeshTriangle(mesh, triangle);
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
};

/** The triangles reachable from one (a plain search over the edges, links and ledges). */
function reachable(set: NavmeshSet, start: { navmesh: Navmesh; triangle: number }): Set<string> {
  const seen = new Set<string>([`${String(start.navmesh.formId)}:${String(start.triangle)}`]);
  const queue: { navmesh: Navmesh; triangle: number }[] = [start];
  for (let next = queue.pop(); next; next = queue.pop()) {
    for (let edge = 0; edge < 3; edge++) {
      const across = triangleNeighbour(next.navmesh, next.triangle, edge);
      if (across === undefined) continue;
      const navmesh = typeof across === 'number' ? next.navmesh : set.navmesh(across.navmesh);
      const triangle = typeof across === 'number' ? across : across.triangle;
      if (!navmesh) continue;
      const key = `${String(navmesh.formId)}:${String(triangle)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ navmesh, triangle });
    }
  }
  return seen;
}

/** Door pairs the plain search connects but no path was found for (a pathfinding fault). */
let missed = 0;
let pairs = 0;
let connected = 0;
let cellsWithDoors = 0;
let cellsAllConnected = 0;
let searchMs = 0;
let longest = 0;
const unconnected: string[] = [];
for (const cell of cells) {
  const meshes = await cellNavmeshes(game.db, cell.formId);
  if (meshes.length === 0) continue;
  // One point per door: the first of its triangles.
  const doors = new Map<number, Vec3>();
  for (const mesh of meshes) {
    for (const entry of mesh.doors) {
      if (!doors.has(entry.door)) doors.set(entry.door, centre(mesh, entry.triangle));
    }
  }
  if (doors.size < 2) continue;
  cellsWithDoors++;
  const set = setOf(meshes);
  const points = [...doors];
  let all = true;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const from = points[i];
      const to = points[j];
      if (!from || !to) continue;
      pairs++;
      const start = performance.now();
      const path = findPath(set, from[1], to[1], { radius });
      const ms = performance.now() - start;
      searchMs += ms;
      longest = Math.max(longest, ms);
      if (path?.complete === true) {
        connected++;
        continue;
      }
      all = false;
      const fromTriangle = set.locate(from[1]);
      const goalTriangle = set.locate(to[1]);
      if (
        fromTriangle &&
        goalTriangle &&
        reachable(set, fromTriangle).has(
          `${String(goalTriangle.navmesh.formId)}:${String(goalTriangle.triangle)}`,
        )
      ) {
        missed++;
        unconnected.push(
          `${cell.editorId} ${from[0].toString(16)} -> ${to[0].toString(16)} MISSED`,
        );
        continue;
      }
      unconnected.push(
        `${cell.editorId} ${from[0].toString(16)} -> ${to[0].toString(16)}${path ? '' : ' (no navmesh at the start)'}`,
      );
    }
  }
  if (all) cellsAllConnected++;
}

console.log(
  `${String(cells.length)} interiors, ${String(cellsWithDoors)} with two or more doors on their navmeshes`,
);
console.log(
  `${String(pairs)} door pairs: ${String(connected)} connect (${((100 * connected) / Math.max(1, pairs)).toFixed(1)} %); ` +
    `${String(cellsAllConnected)} cells connect every pair`,
);
console.log(`${String(missed)} pairs the triangles connect but no path was found for`);
console.log(
  `search: ${(searchMs / Math.max(1, pairs)).toFixed(2)} ms a path on average, ${longest.toFixed(1)} ms the longest`,
);
const byCell = new Map<string, number>();
for (const line of unconnected) {
  const name = line.split(' ')[0] ?? '';
  byCell.set(name, (byCell.get(name) ?? 0) + 1);
}
console.log(`${String(byCell.size)} cells with pairs that do not connect`);
if (list) for (const line of unconnected) console.log(`  ${line}`);
else
  for (const [name, count] of [...byCell].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  ${name}: ${String(count)}`);
  }
