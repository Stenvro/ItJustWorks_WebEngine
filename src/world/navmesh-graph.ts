// The navmesh graph of the load order: which navmeshes lead into which, over their edges
// (within a cell or worldspace) and through their doors (into other cells and worldspaces), so
// the AI knows which navmeshes connect before it searches for a way through their triangles.
// Built from the navmesh info map (NAVI) and the doors' teleports (REFR XTEL), as the engine's
// NavMeshInfoMap links its infos (CommonLibSSE: BSNavmeshInfo adjacentMeshes and
// connectedDoors). Details: docs/formats/esm.md ("Navmesh info map"). Platform-independent.

import { parseTeleport } from './cell-records.ts';
import { cellNavmeshes, NavmeshSurface, type Navmesh } from './navmesh.ts';
import { loadNavmeshInfo, type NavmeshInfoMap } from './navmesh-info.ts';
import type { RecordDatabase } from './record-db.ts';

/** A door on a navmesh and where it leads. */
export interface NavmeshDoorLink {
  /** The door reference on the navmesh. */
  readonly door: number;
  /** The door it leads to (its XTEL); undefined for a door that does not teleport. */
  readonly destination: number | undefined;
  /**
   * The navmeshes on the other side: those with the destination door on them, else the one
   * under the arrival point.
   */
  readonly navmeshes: readonly number[];
}

export interface NavmeshNode {
  readonly navmesh: number;
  /** The worldspace, 0 for interiors. */
  readonly world: number;
  /** Interiors: the cell; worldspaces: its grid (x, y). */
  readonly cell: Navmesh['cell'];
  /** The middle of its vertices (game units). */
  readonly location: readonly [number, number, number];
  /** The navmeshes its edges lead into (in the map). */
  readonly neighbours: readonly number[];
  readonly doors: readonly NavmeshDoorLink[];
  /** Its connected component: an index into NavmeshGraph.components. */
  readonly component: number;
}

/** The navmeshes of the load order and how they connect. */
export class NavmeshGraph {
  readonly nodes: ReadonlyMap<number, NavmeshNode>;
  /**
   * The connected components: navmeshes that reach each other over edges and doors (taken
   * either way), largest first.
   */
  readonly components: readonly (readonly number[])[];

  constructor(nodes: ReadonlyMap<number, NavmeshNode>, components: readonly (readonly number[])[]) {
    this.nodes = nodes;
    this.components = components;
  }

  /** Whether two navmeshes are in the same component (one can be reached from the other). */
  connected(a: number, b: number): boolean {
    const first = this.nodes.get(a);
    return first !== undefined && first.component === this.nodes.get(b)?.component;
  }

  /** The navmeshes one step away: over an edge or through a door. */
  next(navmesh: number): number[] {
    const node = this.nodes.get(navmesh);
    if (!node) return [];
    return [...new Set([...node.neighbours, ...node.doors.flatMap((door) => door.navmeshes)])];
  }
}

/** The navmeshes each door reference is on (their door links). */
export function navmeshesByDoor(map: NavmeshInfoMap): Map<number, number[]> {
  const byDoor = new Map<number, number[]>();
  for (const info of map.infos.values()) {
    for (const door of info.doors) {
      const list = byDoor.get(door) ?? [];
      if (!list.includes(info.navmesh)) list.push(info.navmesh);
      byDoor.set(door, list);
    }
  }
  return byDoor;
}

/**
 * The graph of a navmesh info map. `teleports` names each teleporting door's destination door
 * (XTEL); a door leads to the navmeshes with that door on them, else to its `arrivals`: the
 * navmeshes where it puts one on the other side.
 */
export function buildNavmeshGraph(
  map: NavmeshInfoMap,
  teleports: ReadonlyMap<number, number>,
  arrivals: ReadonlyMap<number, readonly number[]> = new Map(),
): NavmeshGraph {
  const { infos } = map;
  const doorNavmeshes = navmeshesByDoor(map);
  const links = new Map<number, { neighbours: number[]; doors: NavmeshDoorLink[] }>();
  // Components: union-find over the navmeshes' indices.
  const ids = [...infos.keys()];
  const index = new Map(ids.map((id, i) => [id, i]));
  const parent = Int32Array.from(ids, (_, i) => i);
  const root = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] ?? r;
    for (let j = i; parent[j] !== r;) {
      const up = parent[j] ?? r;
      parent[j] = r;
      j = up;
    }
    return r;
  };
  const join = (a: number, b: number): void => {
    const ra = root(index.get(a) ?? 0);
    const rb = root(index.get(b) ?? 0);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (const info of infos.values()) {
    const neighbours = [...new Set([...info.edgeLinks, ...info.preferredEdgeLinks])].filter(
      (other) => other !== info.navmesh && infos.has(other),
    );
    const doors = info.doors.map((door): NavmeshDoorLink => {
      const destination = teleports.get(door);
      const navmeshes =
        destination === undefined
          ? []
          : (doorNavmeshes.get(destination) ?? arrivals.get(door) ?? []).filter((other) =>
              infos.has(other),
            );
      return { door, destination, navmeshes };
    });
    for (const other of neighbours) join(info.navmesh, other);
    for (const door of doors) for (const other of door.navmeshes) join(info.navmesh, other);
    links.set(info.navmesh, { neighbours, doors });
  }
  const members = new Map<number, number[]>();
  ids.forEach((id, i) => {
    const r = root(i);
    const list = members.get(r) ?? [];
    list.push(id);
    members.set(r, list);
  });
  const components = [...members.values()].sort((a, b) => b.length - a.length);
  const componentOf = new Map<number, number>();
  components.forEach((list, component) => {
    for (const id of list) componentOf.set(id, component);
  });
  const nodes = new Map<number, NavmeshNode>();
  for (const info of infos.values()) {
    const { neighbours, doors } = links.get(info.navmesh) ?? { neighbours: [], doors: [] };
    nodes.set(info.navmesh, {
      navmesh: info.navmesh,
      world: info.world,
      cell: info.cell,
      location: info.location,
      neighbours,
      doors,
      component: componentOf.get(info.navmesh) ?? 0,
    });
  }
  return new NavmeshGraph(nodes, components);
}

/**
 * A door's arrival point (its XTEL position) lies this far above or below the navmesh there at
 * most (game units): so for 2,110 of the 2,113 vanilla doors whose destination door is on a
 * navmesh, and the navmesh found is that one. 22 vanilla doors arrive off every navmesh (17 to
 * 2,230 units from the nearest triangle) and lead nowhere here. TODO(M10): how the engine paths
 * through such a door (CommonLibSSE PathingDoor's locations), to compare with the game.
 */
const ARRIVAL_TOLERANCE = 256;

/** The size of an exterior cell (game units). */
const CELL_SIZE = 4096;

/** The navmesh graph of the load order: the NAVI map and the XTEL of every door on it. */
export async function loadNavmeshGraph(db: RecordDatabase): Promise<NavmeshGraph> {
  const map = await loadNavmeshInfo(db);
  const onNavmesh = navmeshesByDoor(map);
  const teleports = new Map<number, number>();
  const arrivals = new Map<number, number[]>();
  for (const door of onNavmesh.keys()) {
    const record = await db.get(door);
    const teleport = record && !record.deleted ? parseTeleport(record) : undefined;
    if (!teleport || teleport.door === 0) continue;
    teleports.set(door, teleport.door);
    // A destination door on no navmesh: the navmesh under the arrival point.
    if (onNavmesh.has(teleport.door)) continue;
    const navmesh = await navmeshAt(db, teleport.door, teleport.position);
    if (navmesh !== undefined) arrivals.set(door, [navmesh]);
  }
  return buildNavmeshGraph(map, teleports, arrivals);
}

/** The navmesh under a point by a reference: in its interior cell, or its exterior cell there. */
async function navmeshAt(
  db: RecordDatabase,
  reference: number,
  [x, y, z]: readonly [number, number, number],
): Promise<number | undefined> {
  let cell = db.cellOfReference(reference);
  if (cell === undefined) return undefined;
  // Exterior (or a worldspace's persistent cell): the cell at the point.
  const world = db.worldOfCell(cell);
  if (world !== undefined) {
    cell = await db.exteriorCell(world, Math.floor(x / CELL_SIZE), Math.floor(y / CELL_SIZE));
    if (cell === undefined) return undefined;
  }
  const surface = new NavmeshSurface(await cellNavmeshes(db, cell));
  return surface.near(x, y, z, ARRIVAL_TOLERANCE)?.navmesh.formId;
}
