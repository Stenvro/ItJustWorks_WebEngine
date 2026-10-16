// Routes across cells (docs/ai.md, "Routes"; docs/m10-plan.md, 2.2): the load doors an actor
// takes from where it is to a place in another cell or worldspace, as the engine's coarse
// pathing over its navmesh info map does (CommonLibSSE: NavMeshInfoMap, BSNavmeshInfo's
// adjacent meshes and connected doors). Within a space, navmeshes that their edges join form
// one area: an actor walks across it (the fine path over its triangles: src/ai/pathfinding.ts);
// a load door (a door with a teleport, XTEL) on an area's navmeshes leads to the area of the
// navmeshes where it puts one on the other side. A route is the cheapest chain of doors: the
// straight lines walked between them, plus a little for each door. Platform-independent.

import { MinHeap } from './min-heap.ts';
import { sameSpace, type Space } from './package-start.ts';

type Vec3 = readonly [number, number, number];

/** A load door as routes take it: where it is and where it leads. */
export interface RouteDoor {
  readonly door: number;
  readonly space: Space;
  readonly position: Vec3;
  /** The navmeshes it is on (this side). */
  readonly navmeshes: readonly number[];
  /** The door on the other side, where one arrives (XTEL), and the navmeshes there. */
  readonly destination: number;
  readonly arrivalSpace: Space;
  readonly arrival: Vec3;
  readonly arrivalHeading: number;
  readonly arrivalNavmeshes: readonly number[];
}

/** A navmesh as routes know it (from the navmesh info map). */
export interface RouteNavmesh {
  readonly space: Space;
  /** The middle of its vertices. */
  readonly location: Vec3;
  /** The navmeshes its edges lead into. */
  readonly neighbours: readonly number[];
}

/** Where a route begins or ends: a point on a navmesh. */
export interface RouteEnd {
  readonly space: Space;
  readonly position: Vec3;
  readonly navmesh: number;
}

/**
 * The roads of a worldspace (the navmesh info map's precomputed paths, NVPP): navmeshes by road
 * markers, and between two of them the navmeshes along the road.
 */
export interface RoadNetwork {
  /** The navmeshes the road markers are on. */
  readonly markers: readonly number[];
  /** The navmeshes from one marker's navmesh to another's, each next to the one before. */
  path(from: number, to: number): readonly number[] | undefined;
}

export interface Route {
  /** The load doors taken, in order. */
  readonly doors: readonly RouteDoor[];
  /** The length walked: straight lines between the doors and the ends (game units). */
  readonly length: number;
}

/** A door costs this much more than the walk to it (game units): routes take few doors. */
const DOOR_COST = 256;
/** A road is taken where it is at most this many times the straight way. */
const ROAD_DETOUR = 1.5;

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The navmeshes and load doors routes are searched over. */
export class RouteMap {
  readonly #navmeshes: ReadonlyMap<number, RouteNavmesh>;
  /** Each navmesh's area: the navmeshes its edges join it with (union-find roots). */
  readonly #areas = new Map<number, number>();
  readonly #doors = new Map<number, RouteDoor[]>();
  readonly #byDoor = new Map<number, RouteDoor>();
  /** The navmeshes of each space. */
  readonly #bySpace = new Map<string, number[]>();
  /** The load doors of each space. */
  readonly #doorsBySpace = new Map<string, RouteDoor[]>();
  readonly #roads: RoadNetwork | undefined;

  constructor(
    navmeshes: ReadonlyMap<number, RouteNavmesh>,
    doors: readonly RouteDoor[],
    roads?: RoadNetwork,
  ) {
    this.#navmeshes = navmeshes;
    this.#roads = roads;
    for (const [id, navmesh] of navmeshes) {
      const key = spaceKey(navmesh.space);
      const list = this.#bySpace.get(key) ?? [];
      list.push(id);
      this.#bySpace.set(key, list);
    }
    const parent = new Map<number, number>();
    const root = (id: number): number => {
      let r = id;
      while ((parent.get(r) ?? r) !== r) r = parent.get(r) ?? r;
      for (let j = id; (parent.get(j) ?? j) !== r;) {
        const up = parent.get(j) ?? r;
        parent.set(j, r);
        j = up;
      }
      return r;
    };
    for (const id of navmeshes.keys()) parent.set(id, id);
    for (const [id, navmesh] of navmeshes) {
      for (const other of navmesh.neighbours) {
        const there = navmeshes.get(other);
        if (!there || !sameSpace(there.space, navmesh.space)) continue;
        const a = root(id);
        const b = root(other);
        if (a !== b) parent.set(Math.max(a, b), Math.min(a, b));
      }
    }
    for (const id of navmeshes.keys()) this.#areas.set(id, root(id));
    for (const door of doors) {
      this.#byDoor.set(door.door, door);
      const key = spaceKey(door.space);
      const inSpace = this.#doorsBySpace.get(key) ?? [];
      inSpace.push(door);
      this.#doorsBySpace.set(key, inSpace);
      const areas = new Set(door.navmeshes.map((navmesh) => this.#areas.get(navmesh)));
      for (const area of areas) {
        if (area === undefined) continue;
        const list = this.#doors.get(area) ?? [];
        list.push(door);
        this.#doors.set(area, list);
      }
    }
  }

  /** A navmesh's area (the navmeshes its edges join it with), if the map has it. */
  areaOf(navmesh: number): number | undefined {
    return this.#areas.get(navmesh);
  }

  /** Where a navmesh is: the middle of its vertices. */
  location(navmesh: number): Vec3 | undefined {
    return this.#navmeshes.get(navmesh)?.location;
  }

  /** A load door by its reference. */
  door(reference: number): RouteDoor | undefined {
    return this.#byDoor.get(reference);
  }

  /** The load doors of a space (on any of its navmeshes). */
  doorsInSpace(space: Space): readonly RouteDoor[] {
    return this.#doorsBySpace.get(spaceKey(space)) ?? [];
  }

  /** The load doors on an area's navmeshes. */
  doorsIn(area: number): readonly RouteDoor[] {
    return this.#doors.get(area) ?? [];
  }

  /**
   * The navmesh of a space whose middle is nearest a point (where a place is in a cell that is
   * not loaded: no triangles to find it on). TODO(M13): the triangle under it (the navmeshes'
   * own data for places away).
   */
  nearestNavmesh(space: Space, point: Vec3): number | undefined {
    let best: number | undefined;
    let nearest = Infinity;
    for (const id of this.#bySpace.get(spaceKey(space)) ?? []) {
      const navmesh = this.#navmeshes.get(id);
      if (!navmesh) continue;
      const d = distance(navmesh.location, point);
      if (d < nearest) {
        nearest = d;
        best = id;
      }
    }
    return best;
  }

  /**
   * The way along the roads between two points of a worldspace: from the first, to the road
   * marker nearest it, along the road's precomputed path to the marker nearest the second, to
   * the second; undefined where the road is no shorter a way (or there is none).
   */
  roadPoints(space: Space, from: Vec3, to: Vec3): Vec3[] | undefined {
    const roads = this.#roads;
    if (!roads || space.kind !== 'world') return undefined;
    const nearestMarker = (point: Vec3): { navmesh: number; at: Vec3 } | undefined => {
      let best: { navmesh: number; at: Vec3 } | undefined;
      let nearest = Infinity;
      for (const marker of roads.markers) {
        const navmesh = this.#navmeshes.get(marker);
        if (!navmesh || !sameSpace(navmesh.space, space)) continue;
        const d = distance(navmesh.location, point);
        if (d < nearest) {
          nearest = d;
          best = { navmesh: marker, at: navmesh.location };
        }
      }
      return best;
    };
    const a = nearestMarker(from);
    const b = nearestMarker(to);
    if (!a || !b || a.navmesh === b.navmesh) return undefined;
    const path = roads.path(a.navmesh, b.navmesh);
    if (!path || path.length === 0) return undefined;
    const points: Vec3[] = [from];
    for (const navmesh of path) {
      const location = this.#navmeshes.get(navmesh)?.location;
      if (location) points.push(location);
    }
    points.push(to);
    // The road only where it is not far round: at most half as long again as the straight way.
    return polylineLength(points) <= distance(from, to) * ROAD_DETOUR ? points : undefined;
  }
}

/** The length of a line through points. */
export function polylineLength(points: readonly Vec3[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) length += distance(a, b);
  }
  return length;
}

const spaceKey = (space: Space): string =>
  space.kind === 'world' ? `w${String(space.world)}` : `c${String(space.cell)}`;

/**
 * The cheapest route from one point to another: the load doors taken in order (none where
 * both are in one area), or undefined where no chain of doors joins their areas.
 */
export function findRoute(map: RouteMap, from: RouteEnd, to: RouteEnd): Route | undefined {
  const start = map.areaOf(from.navmesh);
  const goal = map.areaOf(to.navmesh);
  if (start === undefined || goal === undefined) return undefined;
  if (start === goal) return { doors: [], length: distance(from.position, to.position) };
  // Dijkstra over the doors: a node is a door taken (where one stands on its other side).
  interface Node {
    readonly cost: number;
    readonly area: number;
    readonly at: Vec3;
    readonly door: RouteDoor | undefined;
    readonly previous: Node | undefined;
    readonly length: number;
  }
  const open = new MinHeap<Node>((node) => node.cost);
  open.push({
    cost: 0,
    area: start,
    at: from.position,
    door: undefined,
    previous: undefined,
    length: 0,
  });
  const done = new Set<number>();
  let best: { node: Node; cost: number; length: number } | undefined;
  for (;;) {
    const node = open.pop();
    if (!node) break;
    if (best && node.cost >= best.cost) break;
    if (node.door) {
      if (done.has(node.door.door)) continue;
      done.add(node.door.door);
    }
    if (node.area === goal) {
      const walk = distance(node.at, to.position);
      if (!best || node.cost + walk < best.cost) {
        best = { node, cost: node.cost + walk, length: node.length + walk };
      }
      continue;
    }
    for (const door of map.doorsIn(node.area)) {
      if (done.has(door.door)) continue;
      const area = door.arrivalNavmeshes
        .map((navmesh) => map.areaOf(navmesh))
        .find((found) => found !== undefined);
      // The way back through the door it came out of is no way on.
      if (area === undefined || door.door === node.door?.destination) continue;
      const walk = distance(node.at, door.position);
      open.push({
        cost: node.cost + walk + DOOR_COST,
        area,
        at: door.arrival,
        door,
        previous: node,
        length: node.length + walk,
      });
    }
  }
  if (!best) return undefined;
  const doors: RouteDoor[] = [];
  for (let node: Node | undefined = best.node; node?.door; node = node.previous) {
    doors.unshift(node.door);
  }
  return { doors, length: best.length };
}
