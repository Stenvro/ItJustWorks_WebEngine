// Paths over the navigation meshes of the loaded area (docs/ai.md, "Paths"): A* over their
// triangles, from triangle to triangle across the edges they share (within a mesh, and through
// the links into neighbouring meshes and over ledges), then pulled tight through the edges it
// crosses (the funnel), kept the actor's radius from their ends. Triangles flagged for no large
// creatures are left to the others; water costs more to those that do not swim; preferred
// triangles (roads) cost less; the doors on the way are listed for the actor to open.
// Platform-independent.

import {
  NavmeshFlag,
  NavmeshLinkType,
  navmeshTriangle,
  triangleNeighbour,
  type Navmesh,
} from '../world/navmesh.ts';

type Vec3 = readonly [number, number, number];

/** The navigation meshes paths are searched over (those of the loaded cells). */
export interface NavmeshSet {
  /** A loaded navmesh by its form id. */
  navmesh(formId: number): Navmesh | undefined;
  /** The navmesh triangle under (or nearest above or below) a point, if one is near it. */
  locate(point: Vec3): { readonly navmesh: Navmesh; readonly triangle: number } | undefined;
  /** The navmesh's point nearest to a point (within `reach` across, near its height). */
  nearest?(point: Vec3, reach: number): Vec3 | undefined;
}

export interface PathOptions {
  /** The actor's radius: the path keeps this far from the ends of the edges it crosses. */
  readonly radius: number;
  /** A large creature (it keeps off triangles flagged for no large creatures). */
  readonly large?: boolean;
  /** It swims (water triangles cost it no more). */
  readonly swims?: boolean;
  /** At most this many triangles are searched (a path to the nearest one reached instead). */
  readonly limit?: number;
  /** Doors it cannot pass (locked to it): their triangles are closed. */
  readonly closedDoors?: ReadonlySet<number>;
  /**
   * Places it cannot pass (a door the navmesh does not mark, locked to it): the triangles whose
   * middle lies within each place's radius are closed.
   */
  readonly blocked?: readonly { readonly at: Vec3; readonly radius: number }[];
}

/** A path over the navmeshes. */
export interface NavPath {
  /** From the start to the goal (or the nearest reachable point), pulled tight. */
  readonly points: readonly Vec3[];
  /** The doors (references) on the way, each where the way comes into its triangles. */
  readonly doors: readonly { readonly door: number; readonly at: Vec3 }[];
  /** Whether it reaches the goal's triangle (else it ends nearest the goal it could reach). */
  readonly complete: boolean;
}

/** Water costs this many times its length to actors that do not swim. */
const WATER_COST = 4;
/** Preferred triangles (roads) cost this share of their length. */
const PREFERRED_COST = 0.5;
/** A ledge costs this much more than its length (a jump or a drop). */
const LEDGE_COST = 256;
/** The default search limit (triangles). */
const SEARCH_LIMIT = 20000;

/** A triangle of a mesh, as one number (form ids are 32 bits, triangles 16). */
const keyOf = (navmesh: number, triangle: number): number => navmesh * 65536 + triangle;

interface Node {
  readonly navmesh: Navmesh;
  readonly triangle: number;
  /** Cost from the start and the estimate to the goal. */
  g: number;
  f: number;
  /** Where it was entered (the middle of the edge crossed), and from which node over which edge. */
  readonly at: Vec3;
  parent: Node | undefined;
  /** The edge of the parent's triangle crossed into it. */
  edge: number;
  closed: boolean;
  /** Its place in the open heap (−1: not in it). */
  heap: number;
}

/** A binary min-heap of nodes by f. */
class OpenHeap {
  readonly #items: Node[] = [];

  get size(): number {
    return this.#items.length;
  }

  push(node: Node): void {
    node.heap = this.#items.length;
    this.#items.push(node);
    this.#up(node.heap);
  }

  pop(): Node | undefined {
    const items = this.#items;
    const top = items[0];
    const last = items.pop();
    if (top === undefined || last === undefined) return undefined;
    top.heap = -1;
    if (last !== top) {
      items[0] = last;
      last.heap = 0;
      this.#down(0);
    }
    return top;
  }

  /** A node's f fell: it moves up. */
  update(node: Node): void {
    this.#up(node.heap);
  }

  #up(index: number): void {
    const items = this.#items;
    const node = items[index];
    if (!node) return;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const above = items[parent];
      if (!above || above.f <= node.f) break;
      items[index] = above;
      above.heap = index;
      index = parent;
    }
    items[index] = node;
    node.heap = index;
  }

  #down(index: number): void {
    const items = this.#items;
    const node = items[index];
    if (!node) return;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      let best = node.f;
      const l = items[left];
      if (l && l.f < best) {
        smallest = left;
        best = l.f;
      }
      const r = items[right];
      if (r && r.f < best) smallest = right;
      if (smallest === index) break;
      const child = items[smallest];
      if (!child) break;
      items[index] = child;
      child.heap = index;
      index = smallest;
    }
    items[index] = node;
    node.heap = index;
  }
}

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** An edge's two corners (0: 0–1, 1: 1–2, 2: 2–0). */
function edgeCorners(navmesh: Navmesh, triangle: number, edge: number): [Vec3, Vec3] {
  const corners = navmeshTriangle(navmesh, triangle);
  const a = corners[edge] ?? corners[0];
  const b = corners[(edge + 1) % 3] ?? corners[0];
  return [a, b];
}

const middle = (a: Vec3, b: Vec3): Vec3 => [
  (a[0] + b[0]) / 2,
  (a[1] + b[1]) / 2,
  (a[2] + b[2]) / 2,
];

/** Each navmesh's door triangles: triangle → door reference (read once a navmesh). */
const doorTriangles = new WeakMap<Navmesh, ReadonlyMap<number, number>>();

function doorOf(navmesh: Navmesh, triangle: number): number | undefined {
  let doors = doorTriangles.get(navmesh);
  if (!doors) {
    doors = new Map(navmesh.doors.map((entry) => [entry.triangle, entry.door]));
    doorTriangles.set(navmesh, doors);
  }
  return doors.get(triangle);
}

/** Whether a triangle's middle lies in one of the places closed to the actor. */
function isBlocked(
  navmesh: Navmesh,
  triangle: number,
  places: readonly { readonly at: Vec3; readonly radius: number }[],
): boolean {
  const [x, y] = triangleCentre(navmesh, triangle);
  return places.some((place) => Math.hypot(place.at[0] - x, place.at[1] - y) <= place.radius);
}

/** What it costs to enter a triangle along `length` (its flags against the actor). */
function enterCost(flags: number, length: number, options: PathOptions): number {
  if (options.large === true && (flags & NavmeshFlag.noLargeCreatures) !== 0) return Infinity;
  let cost = length;
  if ((flags & NavmeshFlag.water) !== 0 && options.swims !== true) cost *= WATER_COST;
  else if ((flags & NavmeshFlag.preferred) !== 0) cost *= PREFERRED_COST;
  return cost;
}

/**
 * A path from `from` to `to` over the navmeshes, or undefined when neither point is on one.
 * Where the goal cannot be reached (another island, past the search limit) the path ends where
 * the search came nearest to it (`complete` false).
 */
export function findPath(
  set: NavmeshSet,
  from: Vec3,
  to: Vec3,
  options: PathOptions,
): NavPath | undefined {
  const start = set.locate(from);
  const goal = set.locate(to);
  if (!start) return undefined;
  const goalKey = goal ? keyOf(goal.navmesh.formId, goal.triangle) : undefined;
  const nodes = new Map<number, Node>();
  const open = new OpenHeap();
  const first: Node = {
    navmesh: start.navmesh,
    triangle: start.triangle,
    g: 0,
    f: distance(from, to),
    at: from,
    parent: undefined,
    edge: -1,
    closed: false,
    heap: -1,
  };
  nodes.set(keyOf(start.navmesh.formId, start.triangle), first);
  open.push(first);
  let best = first;
  let bestH = first.f;
  let reached: Node | undefined;
  const limit = options.limit ?? SEARCH_LIMIT;
  let searched = 0;
  while (open.size > 0 && searched < limit) {
    const node = open.pop();
    if (!node) break;
    node.closed = true;
    searched++;
    const key = keyOf(node.navmesh.formId, node.triangle);
    if (key === goalKey) {
      reached = node;
      break;
    }
    const h = distance(node.at, to);
    if (h < bestH) {
      best = node;
      bestH = h;
    }
    for (let edge = 0; edge < 3; edge++) {
      const across = triangleNeighbour(node.navmesh, node.triangle, edge);
      if (across === undefined) continue;
      let navmesh = node.navmesh;
      let triangle: number;
      let extra = 0;
      if (typeof across === 'number') {
        triangle = across;
      } else {
        const next = set.navmesh(across.navmesh);
        if (!next) continue;
        navmesh = next;
        triangle = across.triangle;
        if (across.type === NavmeshLinkType.ledgeUp || across.type === NavmeshLinkType.ledgeDown) {
          extra = LEDGE_COST;
        } else if (across.type !== NavmeshLinkType.portal) {
          continue;
        }
      }
      const target = navmesh.triangles[triangle];
      if (!target || (target.flags & NavmeshFlag.deleted) !== 0) continue;
      // A door it cannot pass closes its triangles.
      const door = options.closedDoors?.size ? doorOf(navmesh, triangle) : undefined;
      if (door !== undefined && options.closedDoors?.has(door) === true) continue;
      if (options.blocked?.length && isBlocked(navmesh, triangle, options.blocked)) continue;
      const neighbourKey = keyOf(navmesh.formId, triangle);
      const existing = nodes.get(neighbourKey);
      if (existing?.closed) continue;
      const [a, b] = edgeCorners(node.navmesh, node.triangle, edge);
      const at = middle(a, b);
      const g = node.g + enterCost(target.flags, distance(node.at, at), options) + extra;
      if (!Number.isFinite(g)) continue;
      if (existing) {
        if (g >= existing.g) continue;
        existing.g = g;
        existing.f = g + distance(existing.at, to);
        existing.parent = node;
        existing.edge = edge;
        if (existing.heap >= 0) open.update(existing);
        else open.push(existing);
        continue;
      }
      const added: Node = {
        navmesh,
        triangle,
        g,
        f: g + distance(at, to),
        at,
        parent: node,
        edge,
        closed: false,
        heap: -1,
      };
      nodes.set(neighbourKey, added);
      open.push(added);
    }
  }
  const end = reached ?? best;
  const chain: Node[] = [];
  for (let node: Node | undefined = end; node; node = node.parent) chain.push(node);
  chain.reverse();
  const goalPoint = reached ? to : end.at;
  return {
    points: pullTight(chain, from, goalPoint, options.radius),
    doors: doorsOn(chain),
    complete: reached !== undefined,
  };
}

/** The doors of the triangles a path crosses, each where the path comes into its triangles. */
function doorsOn(chain: readonly Node[]): { door: number; at: Vec3 }[] {
  const doors: { door: number; at: Vec3 }[] = [];
  const seen = new Set<number>();
  for (const node of chain) {
    const door = doorOf(node.navmesh, node.triangle);
    if (door === undefined || seen.has(door)) continue;
    seen.add(door);
    doors.push({ door, at: node.at });
  }
  return doors;
}

/** 2D cross product of (b − a) and (c − a): > 0 when c is left of a→b. */
const cross = (a: Vec3, b: Vec3, c: Vec3): number =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/**
 * The edges a chain of triangles crosses as portals (left and right corner as one walks
 * through), shrunk by the actor's radius at both ends (an edge narrower than that: its middle).
 */
function portals(chain: readonly Node[], radius: number): [Vec3, Vec3][] {
  const list: [Vec3, Vec3][] = [];
  for (let i = 1; i < chain.length; i++) {
    const node = chain[i];
    const parent = chain[i - 1];
    if (!node || !parent || node.edge < 0) continue;
    const [a, b] = edgeCorners(parent.navmesh, parent.triangle, node.edge);
    // The triangle's corners run counter-clockwise seen from above in the Creation Kit's
    // meshes, but not always: left and right by the walk through the edge's middle.
    const centre = triangleCentre(parent.navmesh, parent.triangle);
    let left = a;
    let right = b;
    if (cross(centre, middle(a, b), a) < 0) {
      left = b;
      right = a;
    }
    const length = Math.hypot(right[0] - left[0], right[1] - left[1]);
    if (length <= radius * 2) {
      const at = middle(left, right);
      list.push([at, at]);
      continue;
    }
    const t = radius / length;
    list.push([lerp(left, right, t), lerp(right, left, t)]);
  }
  return list;
}

const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

function triangleCentre(navmesh: Navmesh, triangle: number): Vec3 {
  const [a, b, c] = navmeshTriangle(navmesh, triangle);
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
}

/**
 * The shortest way through the portals from `from` to `to` (the simple stupid funnel: the
 * apex, and a left and a right side narrowed portal by portal until they cross).
 */
function pullTight(chain: readonly Node[], from: Vec3, to: Vec3, radius: number): Vec3[] {
  const gates = [...portals(chain, radius), [to, to] as [Vec3, Vec3]];
  const points: Vec3[] = [from];
  let apex = from;
  let left = from;
  let right = from;
  let leftIndex = 0;
  let rightIndex = 0;
  for (let i = 0; i < gates.length; i++) {
    const gate = gates[i];
    if (!gate) break;
    const [gateLeft, gateRight] = gate;
    // The right side narrows.
    if (cross(apex, right, gateRight) >= 0) {
      if (samePoint(apex, right) || cross(apex, left, gateRight) < 0) {
        right = gateRight;
        rightIndex = i;
      } else {
        // It crosses the left side: the left corner is a turn.
        points.push(left);
        apex = left;
        right = apex;
        rightIndex = leftIndex;
        i = leftIndex;
        continue;
      }
    }
    // The left side narrows.
    if (cross(apex, left, gateLeft) <= 0) {
      if (samePoint(apex, left) || cross(apex, right, gateLeft) > 0) {
        left = gateLeft;
        leftIndex = i;
      } else {
        points.push(right);
        apex = right;
        left = apex;
        leftIndex = rightIndex;
        i = rightIndex;
        continue;
      }
    }
  }
  const last = points[points.length - 1];
  if (!last || !samePoint(last, to)) points.push(to);
  return points;
}

const samePoint = (a: Vec3, b: Vec3): boolean =>
  Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3;
