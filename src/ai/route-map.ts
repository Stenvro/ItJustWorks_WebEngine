// The route map of the load order (src/ai/routes.ts): every navmesh of the navmesh info map
// (NAVI) with its space and edge links, and every load door on them with its teleport (REFR
// XTEL): where it is, the door it leads to and where one arrives there. Platform-independent.

import { parseReference, parseTeleport } from '../world/cell-records.ts';
import { loadNavmeshInfo, precomputedPath, type NavmeshInfoMap } from '../world/navmesh-info.ts';
import { navmeshesByDoor } from '../world/navmesh-graph.ts';
import type { RecordDatabase } from '../world/record-db.ts';
import type { Space } from './package-start.ts';
import { RouteMap, type RouteDoor, type RouteNavmesh } from './routes.ts';

type Vec3 = readonly [number, number, number];

/** Doors read at once (the reads overlap). */
const BATCH = 64;

/** The space a cell is in: its worldspace, or itself inside. */
function cellSpace(db: RecordDatabase, cell: number): Space {
  const world = db.worldOfCell(cell);
  return world === undefined ? { kind: 'interior', cell } : { kind: 'world', world };
}

/** The space of a navmesh's entry: its worldspace, or its interior cell. */
function navmeshSpace(info: { readonly world: number; readonly cell: unknown }): Space | undefined {
  if (info.world !== 0) return { kind: 'world', world: info.world };
  return typeof info.cell === 'number' ? { kind: 'interior', cell: info.cell } : undefined;
}

/** The route map of a navmesh info map and the load order's doors. */
export async function loadRouteMap(db: RecordDatabase, info?: NavmeshInfoMap): Promise<RouteMap> {
  const map = info ?? (await loadNavmeshInfo(db));
  const navmeshes = new Map<number, RouteNavmesh>();
  for (const entry of map.infos.values()) {
    const space = navmeshSpace(entry);
    if (!space) continue;
    navmeshes.set(entry.navmesh, {
      space,
      location: entry.location,
      neighbours: [...entry.edgeLinks, ...entry.preferredEdgeLinks],
    });
  }
  const onNavmesh = navmeshesByDoor(map);
  /** The navmesh of a space whose middle is nearest a point (an arrival on no door's mesh). */
  const nearest = (space: Space, point: Vec3): number | undefined => {
    let best: number | undefined;
    let distance = Infinity;
    for (const [id, navmesh] of navmeshes) {
      if (navmesh.space.kind !== space.kind) continue;
      if (space.kind === 'interior' && navmesh.space.kind === 'interior') {
        if (navmesh.space.cell !== space.cell) continue;
      } else if (space.kind === 'world' && navmesh.space.kind === 'world') {
        if (navmesh.space.world !== space.world) continue;
      }
      const [x, y, z] = navmesh.location;
      const d = Math.hypot(x - point[0], y - point[1], z - point[2]);
      if (d < distance) {
        distance = d;
        best = id;
      }
    }
    return best;
  };
  const doors: RouteDoor[] = [];
  const references = [...onNavmesh.keys()];
  for (let i = 0; i < references.length; i += BATCH) {
    const records = await Promise.all(references.slice(i, i + BATCH).map((door) => db.get(door)));
    for (const record of records) {
      if (!record || record.deleted) continue;
      const teleport = parseTeleport(record);
      if (!teleport || teleport.door === 0) continue;
      const cell = db.cellOfReference(record.formId);
      const arrivalCell = db.cellOfReference(teleport.door);
      if (cell === undefined || arrivalCell === undefined) continue;
      const arrivalSpace = cellSpace(db, arrivalCell);
      const there = onNavmesh.get(teleport.door);
      const arrivalNavmeshes =
        there && there.length > 0
          ? there
          : [nearest(arrivalSpace, teleport.position)].filter(
              (navmesh): navmesh is number => navmesh !== undefined,
            );
      doors.push({
        door: record.formId,
        space: cellSpace(db, cell),
        position: parseReference(record).position,
        navmeshes: onNavmesh.get(record.formId) ?? [],
        destination: teleport.door,
        arrivalSpace,
        arrival: teleport.position,
        arrivalHeading: teleport.rotation[2],
        arrivalNavmeshes,
      });
    }
  }
  return new RouteMap(navmeshes, doors, {
    markers: map.roadMarkers.map((marker) => marker.navmesh),
    path: (from, to) => precomputedPath(map, from, to),
  });
}
