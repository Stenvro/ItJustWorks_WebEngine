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
import { ObstacleIndex, type NavmeshObstacle } from './navmesh-obstacles.ts';

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
  /**
   * The active navmesh obstacles (src/ai/navmesh-obstacles.ts): the triangles whose middle lies
   * under one and the steps that cross one are closed.
   */
  readonly obstacles?: ObstacleIndex | readonly NavmeshObstacle[];
  /**
   * Avoid nodes (the actors that blocked it standing; the engine's, observed in the original): a circle the
   * actor's middle keeps out of (`radius`: theirs and its own) and the cost of each unit a path
   * step runs inside it (`cost` times its length). The triangles whose middle lies within one
   * are closed (the goal's not); the way pulled tight goes round them where the navmeshes have
   * room.
   */
  readonly avoid?: readonly AvoidNode[];
}

/** A place a path goes round (a standing actor that blocked the one searching). */
export interface AvoidNode {
  readonly at: Vec3;
  readonly radius: number;
  /** Each unit of a step inside it costs this many (fAvoidNodeCost). */
  readonly cost: number;
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

/** The obstacles of a search, indexed (undefined: none). */
function obstacleIndex(
  obstacles: ObstacleIndex | readonly NavmeshObstacle[] | undefined,
): ObstacleIndex | undefined {
  if (obstacles instanceof ObstacleIndex) return obstacles;
  return obstacles?.length ? new ObstacleIndex(obstacles) : undefined;
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
  const obstacles = obstacleIndex(options.obstacles);
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
      if (
        options.avoid?.length &&
        neighbourKey !== goalKey &&
        isBlocked(navmesh, triangle, options.avoid)
      ) {
        continue;
      }
      const existing = nodes.get(neighbourKey);
      if (existing?.closed) continue;
      const [a, b] = edgeCorners(node.navmesh, node.triangle, edge);
      const at = middle(a, b);
      // An obstacle's cut closes the triangles under it and the steps across it.
      if (
        obstacles &&
        (obstacles.covers(triangleCentre(navmesh, triangle)) || obstacles.crosses(node.at, at))
      ) {
        continue;
      }
      // A step through an avoid node costs its length inside it, many times over.
      const avoided = options.avoid?.length ? avoidCost(node.at, at, options.avoid) : 0;
      const g = node.g + enterCost(target.flags, distance(node.at, at), options) + extra + avoided;
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
  const tight = pullTight(chain, from, goalPoint, options.radius);
  return {
    points: options.avoid?.length
      ? goRoundAll(set, tight, options.avoid, options.radius, obstacles)
      : tight,
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

const across = (a: Vec3, b: Vec3): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

/**
 * Whether a step from `a` to `b` comes into a circle (horizontally). A step that begins inside
 * it counts only if it goes deeper (an actor pressed against another walks off it).
 */
function entersCircle(a: Vec3, b: Vec3, circle: AvoidNode): boolean {
  const [cx, cy] = circle.at;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t =
    length2 > 1e-9 ? Math.max(0, Math.min(1, ((cx - a[0]) * dx + (cy - a[1]) * dy) / length2)) : 0;
  const closest = Math.hypot(a[0] + dx * t - cx, a[1] + dy * t - cy);
  const start = Math.hypot(a[0] - cx, a[1] - cy);
  return closest < circle.radius - 1e-3 && closest < start - 1e-3;
}

/** What a step costs more through avoid nodes: its length inside each, times the node's cost. */
function avoidCost(a: Vec3, b: Vec3, nodes: readonly AvoidNode[]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return 0;
  let cost = 0;
  for (const node of nodes) {
    // Where the step's line meets the circle: t² + 2pt + q = 0 along its length.
    const ox = a[0] - node.at[0];
    const oy = a[1] - node.at[1];
    const p = (ox * dx + oy * dy) / length;
    const q = ox * ox + oy * oy - node.radius * node.radius;
    const root = p * p - q;
    if (root <= 0) continue;
    const enter = Math.max(0, -p - Math.sqrt(root));
    const leave = Math.min(length, -p + Math.sqrt(root));
    if (leave > enter) cost += (leave - enter) * node.cost;
  }
  return cost;
}

/** The ring round a node is drawn in arcs of at most this (radians). */
const ROUND_ARC = Math.PI / 4;
/** Two ways round a node at once at the most (a node beside another). */
const ROUND_PASSES = 2;

/**
 * A path pulled tight, bent round the avoid nodes its steps run into: each such step goes round
 * the node on the shorter side the navmeshes leave room on (the actor's width, else its middle),
 * as tight as the node lets it. A step ending inside a node (the goal beside the one in the way)
 * cannot go round it and stays.
 */
function goRoundAll(
  set: NavmeshSet,
  points: readonly Vec3[],
  nodes: readonly AvoidNode[],
  radius: number,
  obstacles: ObstacleIndex | undefined,
): Vec3[] {
  let way = [...points];
  for (let pass = 0; pass < ROUND_PASSES; pass++) {
    let bent = false;
    for (const node of nodes) {
      const first = way[0];
      if (!first) return way;
      const out: Vec3[] = [first];
      for (let i = 1; i < way.length; i++) {
        const b = way[i];
        const a = out[out.length - 1];
        if (!a || !b) continue;
        if (entersCircle(a, b, node) && across(node.at, b) >= node.radius) {
          const round = goRound(set, a, b, node, radius, obstacles);
          if (round) {
            out.push(...round);
            bent = true;
          }
        }
        out.push(b);
      }
      way = out;
    }
    if (!bent) break;
  }
  return way;
}

/** The points of the shorter way round a node from `a` to `b`, or undefined (no room). */
function goRound(
  set: NavmeshSet,
  a: Vec3,
  b: Vec3,
  node: AvoidNode,
  radius: number,
  obstacles: ObstacleIndex | undefined,
): Vec3[] | undefined {
  const [cx, cy] = node.at;
  const fromAngle = Math.atan2(a[1] - cy, a[0] - cx);
  const toAngle = Math.atan2(b[1] - cy, b[0] - cx);
  const clear = (p: Vec3, q: Vec3, width: number): boolean =>
    straightReach(set, p, q, width) >= across(p, q) - 1 && obstacles?.crosses(p, q) !== true;
  for (const width of radius > 0 ? [radius, 0] : [0]) {
    let best: { points: Vec3[]; length: number } | undefined;
    for (const side of [1, -1]) {
      const sweep =
        (((side * (toAngle - fromAngle)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (sweep < 1e-6) continue;
      // A polygon round the circle, its sides touching it.
      const arcs = Math.max(1, Math.ceil(sweep / ROUND_ARC));
      const arc = sweep / arcs;
      const ring = (node.radius + 1) / Math.cos(arc / 2);
      const corners: Vec3[] = [];
      for (let k = 0; k <= arcs; k++) {
        const angle = fromAngle + side * k * arc;
        const x = cx + Math.cos(angle) * ring;
        const y = cy + Math.sin(angle) * ring;
        const z = a[2] + ((b[2] - a[2]) * k) / arcs;
        corners.push([x, y, set.nearest?.([x, y, z], ROUND_FLOOR_REACH)?.[2] ?? z]);
      }
      // Pulled tight: from each point kept to the farthest it sees past the circle.
      const list = [...corners, b];
      const kept: Vec3[] = [];
      let from = a;
      for (let next = 0; next < list.length;) {
        let j = list.length - 1;
        while (j > next) {
          const to = list[j];
          if (to && !entersCircle(from, to, node)) break;
          j--;
        }
        const to = list[j];
        if (!to || j === list.length - 1) break;
        kept.push(to);
        from = to;
        next = j + 1;
      }
      const way = [a, ...kept, b];
      let length = 0;
      let ok = true;
      for (let i = 1; i < way.length && ok; i++) {
        const p = way[i - 1];
        const q = way[i];
        if (!p || !q) continue;
        ok = clear(p, q, width);
        length += across(p, q);
      }
      if (ok && (!best || length < best.length)) best = { points: kept, length };
    }
    if (best) return best.points;
  }
  return undefined;
}

/** A corner of the way round a node is set on the navmesh within this of its height (units). */
const ROUND_FLOOR_REACH = 64;

/** The line's samples are this far apart (units). */
const STRAIGHT_STEP = 16;

/**
 * How far the navmeshes let an actor go straight from `from` towards `to` (units, horizontal):
 * the line and the two lines its radius to either side, sampled every 16 units, stay on the
 * navmeshes up to there (the engine's straight combat paths, CombatPathRequestStraightPath: a
 * maneuver's goal the navmesh does not reach is no goal). Off the navmeshes (none loaded under
 * its start) the whole way counts.
 */
export function straightReach(set: NavmeshSet, from: Vec3, to: Vec3, radius: number): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-6 || !set.locate(from)) return length;
  const ux = dx / length;
  const uy = dy / length;
  // Across the way: (uy, −ux) to the right.
  const offsets = radius > 0 ? [0, radius, -radius] : [0];
  for (let along = STRAIGHT_STEP; along < length + STRAIGHT_STEP; along += STRAIGHT_STEP) {
    const at = Math.min(along, length);
    const z = from[2] + ((to[2] - from[2]) * at) / length;
    for (const offset of offsets) {
      const point: Vec3 = [from[0] + ux * at + uy * offset, from[1] + uy * at - ux * offset, z];
      if (!set.locate(point)) return Math.max(0, at - STRAIGHT_STEP);
    }
  }
  return length;
}

/**
 * Where a summon stands on the navmeshes (the engine looks for the navmesh near the place ahead
 * of its summoner, the way to it clear; observed in the original): as far toward `to` as an
 * actor of `radius` goes straight from `from` on the navmeshes (straightReach), on the navmesh
 * there (its column). Off the navmeshes the place itself, on a navmesh beneath or above it if one
 * is there; undefined if nothing is (the caller keeps its place).
 */
export function summonPlace(
  set: NavmeshSet,
  from: Vec3,
  to: Vec3,
  radius: number,
): [number, number, number] | undefined {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const reach = set.locate(from) ? straightReach(set, from, to, radius) : length;
  const share = length > 1e-6 ? Math.min(1, reach / length) : 1;
  const point: Vec3 = [
    from[0] + (to[0] - from[0]) * share,
    from[1] + (to[1] - from[1]) * share,
    from[2] + (to[2] - from[2]) * share,
  ];
  const on = onNavmeshColumn(set, point);
  return on && [on[0], on[1], on[2]];
}

/** A random location's search reaches at most this many triangles. */
const RANDOM_SEARCH_LIMIT = 4000;
/** A random location is tried this many times to lie far enough from the actor. */
const RANDOM_TRIES = 8;

/**
 * A random point of the navmeshes within `radius` of `center` that an actor at `from` can walk
 * to, at least `least` from it if such a point is found in a few tries (else the farthest
 * found): the pathing's random location, which the engine's wander asks for its first walk
 * (observed in the original). The triangles reachable from the actor's (through the edges
 * and portals a path takes, closed ones left out) whose middle lies within the radius are the
 * candidates, picked by their area; the point is random within the triangle picked. Undefined:
 * the actor is off the navmeshes, or nothing it reaches lies within the radius.
 */
export function randomReachablePoint(
  set: NavmeshSet,
  from: Vec3,
  center: Vec3,
  radius: number,
  least: number,
  random: () => number,
  options: Pick<PathOptions, 'large' | 'closedDoors' | 'obstacles'> = {},
): Vec3 | undefined {
  const start = set.locate(from);
  if (!start) return undefined;
  const obstacles = obstacleIndex(options.obstacles);
  const candidates: { navmesh: Navmesh; triangle: number; area: number }[] = [];
  const seen = new Set<number>([keyOf(start.navmesh.formId, start.triangle)]);
  const queue: { navmesh: Navmesh; triangle: number }[] = [start];
  let total = 0;
  const across2d = (point: Vec3): number => Math.hypot(point[0] - center[0], point[1] - center[1]);
  // Farther from the place than this (and than the actor stands), the search does not go on.
  const farthest = Math.max(2 * radius, across2d(from)) + RANDOM_SEARCH_MARGIN;
  for (let i = 0; i < queue.length && seen.size < RANDOM_SEARCH_LIMIT; i++) {
    const { navmesh, triangle } = queue[i] ?? start;
    const middle = triangleCentre(navmesh, triangle);
    const off = across2d(middle);
    if (off <= radius) {
      const [a, b, c] = navmeshTriangle(navmesh, triangle);
      const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
      if (area > 0) {
        candidates.push({ navmesh, triangle, area });
        total += area;
      }
    } else if (off > farthest) {
      // Far outside the place: the search does not go on from there.
      continue;
    }
    for (let edge = 0; edge < 3; edge++) {
      const neighbour = triangleNeighbour(navmesh, triangle, edge);
      if (neighbour === undefined) continue;
      let next = navmesh;
      let index: number;
      if (typeof neighbour === 'number') {
        index = neighbour;
      } else {
        if (neighbour.type !== NavmeshLinkType.portal) continue;
        const other = set.navmesh(neighbour.navmesh);
        if (!other) continue;
        next = other;
        index = neighbour.triangle;
      }
      const key = keyOf(next.formId, index);
      if (seen.has(key)) continue;
      seen.add(key);
      const target = next.triangles[index];
      if (!target || (target.flags & NavmeshFlag.deleted) !== 0) continue;
      if (!Number.isFinite(enterCost(target.flags, 1, { radius: 0, ...options }))) continue;
      const door = options.closedDoors?.size ? doorOf(next, index) : undefined;
      if (door !== undefined && options.closedDoors?.has(door) === true) continue;
      if (obstacles?.covers(triangleCentre(next, index))) continue;
      queue.push({ navmesh: next, triangle: index });
    }
  }
  if (candidates.length === 0 || total <= 0) return undefined;
  let best: Vec3 | undefined;
  let bestAway = -1;
  for (let attempt = 0; attempt < RANDOM_TRIES; attempt++) {
    let pick = random() * total;
    const chosen = candidates.find((candidate) => (pick -= candidate.area) <= 0) ?? candidates[0];
    if (!chosen) break;
    const [a, b, c] = navmeshTriangle(chosen.navmesh, chosen.triangle);
    let u = random();
    let v = random();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    const point: Vec3 = [
      a[0] + (b[0] - a[0]) * u + (c[0] - a[0]) * v,
      a[1] + (b[1] - a[1]) * u + (c[1] - a[1]) * v,
      a[2] + (b[2] - a[2]) * u + (c[2] - a[2]) * v,
    ];
    const away = Math.hypot(point[0] - from[0], point[1] - from[1]);
    if (away > bestAway) {
      best = point;
      bestAway = away;
    }
    if (away >= least) return point;
  }
  return best;
}

/** How far beyond twice its radius (or the actor) from a place a random location's search goes on. */
const RANDOM_SEARCH_MARGIN = 512;

/** A point is looked for on the navmesh this far above and below it (units)... */
const COLUMN_REACH = 1024;
/** ... in steps of this (twice the navmesh's own tolerance, NAVMESH_TOLERANCE). */
const COLUMN_STEP = 48;

/**
 * Where a point's column meets the navmesh: the point itself if a triangle is at its height,
 * else the nearest height above or below it (within COLUMN_REACH) where one is. A wander point
 * is at its place's middle's height (the engine's), wherever the ground there lies.
 */
export function onNavmeshColumn(set: NavmeshSet, point: Vec3): Vec3 | undefined {
  for (let rise = 0; rise <= COLUMN_REACH; rise += COLUMN_STEP) {
    for (const dz of rise === 0 ? [0] : [-rise, rise]) {
      const at: Vec3 = [point[0], point[1], point[2] + dz];
      if (set.locate(at)) return at;
    }
  }
  return undefined;
}
