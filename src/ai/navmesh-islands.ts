// The islands of a set of navigation meshes: the triangles a search can reach from a triangle,
// over its edges and the edge links a search crosses (portals, ledges), whatever the searcher's
// options (they only close more). A goal outside the island a search begins in cannot be
// reached however long it searches; findPath goes to the island's point nearest the goal
// instead of searching the whole island for it (src/ai/pathfinding.ts, docs/ai.md "Paths").
//
// Making an island and finding its nearest point are part of a search, so they take from its
// share like its nodes (a triangle flooded, a grid cell or triangle looked at: one each) and give
// way when it is spent: a search over frames never takes more than a frame gives it.

import {
  NavmeshFlag,
  NavmeshLinkType,
  navmeshTriangle,
  triangleNeighbour,
  type Navmesh,
} from '../world/navmesh.ts';

type Vec3 = readonly [number, number, number];

/** The navmeshes by form id (a NavmeshSet's lookup). */
export interface NavmeshLookup {
  navmesh(formId: number): Navmesh | undefined;
}

/** What a search may take: it gives way once it has taken `allowance` (`taken`, counted). */
export interface IslandShare {
  allowance: number;
  taken: number;
}

/** A point of an island, and the triangle it lies in. */
export interface IslandPoint {
  readonly at: Vec3;
  readonly navmesh: Navmesh;
  readonly triangle: number;
}

/** A nearest point being looked for: the best so far, the triangles looked at. */
interface NearestQuery {
  readonly point: Vec3;
  readonly share: IslandShare;
  readonly looked: Set<number>;
  best: IslandPoint | undefined;
  bestD: number;
}

/** A square of an island's grid: the triangles whose bounds cover it, the heights they span. */
interface GridSquare {
  readonly ids: number[];
  minZ: number;
  maxZ: number;
}

/** The side of the island's grid squares (game units; an exterior cell is 4,096). */
const GRID = 256;
/**
 * The grid's squares are keyed by x and y offset by this: 2,000,000 units either way (a
 * worldspace is far smaller), the keys small integers (a map keyed by larger ones is far slower).
 */
const GRID_OFFSET = 1 << 13;
/**
 * Nearest points kept per island, by the grid square of the goals asked most lately (several
 * actors, one goal; a moving goal stays in a square a while).
 */
const NEAREST_KEPT = 64;

const gridKey = (gx: number, gy: number): number =>
  (gx + GRID_OFFSET) * 2 * GRID_OFFSET + (gy + GRID_OFFSET);

/**
 * The triangles reached from one triangle over the edges and the links a search crosses (one
 * way: a ledge down is crossed, its foot need not lead back up). Made a share at a time (`grow`)
 * and kept while the navmeshes it was made of are the loaded ones and none it led into but found
 * unloaded has loaded since.
 */
export class NavmeshIsland {
  /** Each navmesh it reaches, by form id, and the triangles it reaches of it. */
  readonly #reached = new Map<
    number,
    { readonly navmesh: Navmesh; readonly triangles: Uint8Array }
  >();
  /** Navmeshes its links lead into that were not loaded as it was made. */
  readonly #missing = new Set<number>();
  /**
   * The triangles marked but not yet flooded from (each: its navmesh and index), flooded from in
   * the order marked from `#openHead` on: outward from the first, so a triangle near it is found
   * early (a search asks whether its goal is on the island while it is made).
   */
  #openMesh: Navmesh[] = [];
  #openTriangle: number[] = [];
  #openHead = 0;
  /**
   * Its triangles by the grid squares their bounds cover (indices into the two lists below), and
   * the heights they span in each.
   */
  readonly #grid = new Map<number, GridSquare>();
  readonly #gridMesh: Navmesh[] = [];
  readonly #gridTriangle: number[] = [];
  /** The grid squares it covers, and the heights. */
  #minX = Infinity;
  #minY = Infinity;
  #maxX = -Infinity;
  #maxY = -Infinity;
  #minZ = Infinity;
  #maxZ = -Infinity;
  /** The nearest points lately asked for, by the goal's grid square (gridKey), the goal kept. */
  readonly #nearestKept = new Map<number, { readonly goal: Vec3; readonly near: IslandPoint }>();
  readonly #set: NavmeshLookup;
  readonly #slots: WeakMap<Navmesh, (NavmeshIsland | undefined)[]> | undefined;
  /** How many triangles it reaches (so far, while it is being made). */
  size = 0;

  /**
   * `slots`: the triangles' islands of the set (each triangle it marks finds it there, so a
   * search begun on one while it is being made goes on making it).
   */
  constructor(
    set: NavmeshLookup,
    navmesh: Navmesh,
    triangle: number,
    slots?: WeakMap<Navmesh, (NavmeshIsland | undefined)[]>,
  ) {
    this.#set = set;
    this.#slots = slots;
    this.#mark(navmesh, triangle);
  }

  /** Whether it is made whole (every triangle it reaches found). */
  get complete(): boolean {
    return this.#openHead >= this.#openMesh.length;
  }

  /** The last navmesh marked in: its reached triangles and islands' slots. */
  #lastMesh: Navmesh | undefined;
  #lastTriangles: Uint8Array | undefined;
  #lastSlots: (NavmeshIsland | undefined)[] | undefined;

  #mark(into: Navmesh, index: number): void {
    if (into !== this.#lastMesh) {
      let entry = this.#reached.get(into.formId);
      if (!entry) {
        entry = { navmesh: into, triangles: new Uint8Array(into.triangles.length) };
        this.#reached.set(into.formId, entry);
      }
      let own = this.#slots?.get(into);
      if (this.#slots && !own) {
        own = new Array<NavmeshIsland | undefined>(into.triangles.length).fill(undefined);
        this.#slots.set(into, own);
      }
      this.#lastMesh = into;
      this.#lastTriangles = entry.triangles;
      this.#lastSlots = own;
    }
    const triangles = this.#lastTriangles;
    if (!triangles || triangles[index] === 1) return;
    triangles[index] = 1;
    this.size++;
    this.#openMesh.push(into);
    this.#openTriangle.push(index);
    if (this.#lastSlots) this.#lastSlots[index] = this;
  }

  /** Its grid: the triangle in each square its horizontal bounds cover. */
  #index(navmesh: Navmesh, index: number): void {
    const corners = navmesh.triangles[index]?.vertices;
    if (!corners) return;
    const v = navmesh.vertices;
    const a = corners[0] * 3;
    const b = corners[1] * 3;
    const c = corners[2] * 3;
    const ax = v[a] ?? 0;
    const bx = v[b] ?? 0;
    const cx = v[c] ?? 0;
    const ay = v[a + 1] ?? 0;
    const by = v[b + 1] ?? 0;
    const cy = v[c + 1] ?? 0;
    const az = v[a + 2] ?? 0;
    const bz = v[b + 2] ?? 0;
    const cz = v[c + 2] ?? 0;
    const x0 = Math.floor(Math.min(ax, bx, cx) / GRID);
    const x1 = Math.floor(Math.max(ax, bx, cx) / GRID);
    const y0 = Math.floor(Math.min(ay, by, cy) / GRID);
    const y1 = Math.floor(Math.max(ay, by, cy) / GRID);
    const z0 = Math.min(az, bz, cz);
    const z1 = Math.max(az, bz, cz);
    const id = this.#gridMesh.length;
    this.#gridMesh.push(navmesh);
    this.#gridTriangle.push(index);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const key = gridKey(gx, gy);
        const square = this.#grid.get(key);
        if (square) {
          square.ids.push(id);
          if (z0 < square.minZ) square.minZ = z0;
          if (z1 > square.maxZ) square.maxZ = z1;
        } else this.#grid.set(key, { ids: [id], minZ: z0, maxZ: z1 });
      }
    }
    if (x0 < this.#minX) this.#minX = x0;
    if (x1 > this.#maxX) this.#maxX = x1;
    if (y0 < this.#minY) this.#minY = y0;
    if (y1 > this.#maxY) this.#maxY = y1;
    if (z0 < this.#minZ) this.#minZ = z0;
    if (z1 > this.#maxZ) this.#maxZ = z1;
  }

  /**
   * Floods on from the triangles marked until it is whole or `share` is spent (each triangle
   * flooded from takes one); whether it is whole.
   */
  grow(share: IslandShare): boolean {
    const openMesh = this.#openMesh;
    const openTriangle = this.#openTriangle;
    while (this.#openHead < openMesh.length) {
      if (share.taken >= share.allowance) return false;
      share.taken++;
      const at = openMesh[this.#openHead];
      const index = openTriangle[this.#openHead];
      this.#openHead++;
      if (!at || index === undefined) continue;
      this.#index(at, index);
      for (let edge = 0; edge < 3; edge++) {
        const across = triangleNeighbour(at, index, edge);
        if (across === undefined) continue;
        let into = at;
        let target: number;
        if (typeof across === 'number') target = across;
        else {
          if (
            across.type !== NavmeshLinkType.portal &&
            across.type !== NavmeshLinkType.ledgeUp &&
            across.type !== NavmeshLinkType.ledgeDown
          ) {
            continue;
          }
          const loaded = this.#set.navmesh(across.navmesh);
          if (!loaded) {
            this.#missing.add(across.navmesh);
            continue;
          }
          into = loaded;
          target = across.triangle;
        }
        const t = into.triangles[target];
        if (!t || (t.flags & NavmeshFlag.deleted) !== 0) continue;
        this.#mark(into, target);
      }
    }
    // Whole: the lists let go.
    this.#openMesh = [];
    this.#openTriangle = [];
    this.#openHead = 0;
    return true;
  }

  /** The navmeshes it reaches and, of each, which triangles (1: reached). */
  *navmeshes(): Generator<readonly [Navmesh, Uint8Array]> {
    for (const { navmesh, triangles } of this.#reached.values()) yield [navmesh, triangles];
  }

  /** Whether it reaches a triangle (of those found so far, while it is being made). */
  has(navmesh: Navmesh, triangle: number): boolean {
    const entry = this.#reached.get(navmesh.formId);
    return entry?.navmesh === navmesh && entry.triangles[triangle] === 1;
  }

  /** Whether it still holds: its navmeshes are the loaded ones, none it lacked has loaded. */
  current(set: NavmeshLookup): boolean {
    for (const [formId, entry] of this.#reached) {
      if (set.navmesh(formId) !== entry.navmesh) return false;
    }
    for (const formId of this.#missing) if (set.navmesh(formId)) return false;
    return true;
  }

  /** Looks at a grid square's triangles for a nearer point (the square and each take one). */
  *#look(gx: number, gy: number, query: NearestQuery): Generator<undefined, void, undefined> {
    if (gx < this.#minX || gx > this.#maxX || gy < this.#minY || gy > this.#maxY) return;
    const { point, share, looked } = query;
    if (share.taken >= share.allowance) yield;
    share.taken++;
    const square = this.#grid.get(gridKey(gx, gy));
    if (!square) return;
    // Nothing in it can be nearer than its bounds (the square, the heights its triangles span).
    const dx = Math.max(gx * GRID - point[0], 0, point[0] - (gx + 1) * GRID);
    const dy = Math.max(gy * GRID - point[1], 0, point[1] - (gy + 1) * GRID);
    const dz = Math.max(square.minZ - point[2], 0, point[2] - square.maxZ);
    if (dx * dx + dy * dy + dz * dz >= query.bestD) return;
    for (const id of square.ids) {
      if (looked.has(id)) continue;
      looked.add(id);
      if (share.taken >= share.allowance) yield;
      share.taken++;
      const navmesh = this.#gridMesh[id];
      const index = this.#gridTriangle[id];
      if (!navmesh || index === undefined) continue;
      const [a, b, c] = navmeshTriangle(navmesh, index);
      const at = closestOnTriangle(point, a, b, c);
      const d = (at[0] - point[0]) ** 2 + (at[1] - point[1]) ** 2 + (at[2] - point[2]) ** 2;
      if (d < query.bestD) {
        query.bestD = d;
        query.best = { at, navmesh, triangle: index };
      }
    }
  }

  /**
   * Its point nearest to `point` (straight, in 3D), and the triangle it lies in; made whole
   * first. Looks at the grid squares outward from the point's (each square and each triangle in
   * one takes one of `share`), giving way when `share` is spent. The last points asked for are
   * kept by the goal's grid square: the same goal again is answered at once; another in its
   * square (soldiers chasing one dragon, each asking where it is then) begins from the point of
   * the triangle kept for it, so only what may lie nearer is looked at, and the answer is exact.
   */
  *nearestSteps(point: Vec3, share: IslandShare): Generator<undefined, IslandPoint, undefined> {
    while (!this.grow(share)) yield;
    const cx = Math.floor(point[0] / GRID);
    const cy = Math.floor(point[1] / GRID);
    const square = gridKey(cx, cy);
    const kept = this.#nearestKept.get(square);
    if (kept) {
      // Asked again: kept the longest from now on.
      this.#nearestKept.delete(square);
      this.#nearestKept.set(square, kept);
      if (kept.goal[0] === point[0] && kept.goal[1] === point[1] && kept.goal[2] === point[2]) {
        return kept.near;
      }
    }
    // The rings of squares round the point's that reach the island's squares.
    const outside = Math.max(this.#minX - cx, cx - this.#maxX, this.#minY - cy, cy - this.#maxY);
    const first = Math.max(0, outside);
    const last = Math.max(
      Math.abs(cx - this.#minX),
      Math.abs(cx - this.#maxX),
      Math.abs(cy - this.#minY),
      Math.abs(cy - this.#maxY),
    );
    const query: NearestQuery = {
      point,
      share,
      looked: new Set(),
      best: undefined,
      bestD: Infinity,
    };
    if (kept) {
      // The kept triangle's point nearest this goal: nothing farther need be looked at.
      if (share.taken >= share.allowance) yield;
      share.taken++;
      const { navmesh, triangle } = kept.near;
      const [a, b, c] = navmeshTriangle(navmesh, triangle);
      const at = closestOnTriangle(point, a, b, c);
      query.best = { at, navmesh, triangle };
      query.bestD = (at[0] - point[0]) ** 2 + (at[1] - point[1]) ** 2 + (at[2] - point[2]) ** 2;
    }
    // No point of it lies nearer in height than its heights' span.
    const dz = Math.max(this.#minZ - point[2], 0, point[2] - this.#maxZ);
    for (let ring = first; ring <= last; ring++) {
      // Every point of a square `ring` squares out lies at least ring - 1 squares away.
      const across = Math.max(0, ring - 1) * GRID;
      if (query.best && query.bestD <= across * across + dz * dz) break;
      if (ring === 0) {
        yield* this.#look(cx, cy, query);
        continue;
      }
      const x0 = Math.max(cx - ring, this.#minX);
      const x1 = Math.min(cx + ring, this.#maxX);
      for (let gx = x0; gx <= x1; gx++) {
        yield* this.#look(gx, cy - ring, query);
        yield* this.#look(gx, cy + ring, query);
      }
      const y0 = Math.max(cy - ring + 1, this.#minY);
      const y1 = Math.min(cy + ring - 1, this.#maxY);
      for (let gy = y0; gy <= y1; gy++) {
        yield* this.#look(cx - ring, gy, query);
        yield* this.#look(cx + ring, gy, query);
      }
    }
    const best = query.best;
    // An island reaches at least the triangle it was made from.
    if (!best) throw new Error('navmesh island without triangles');
    this.#nearestKept.delete(square);
    if (this.#nearestKept.size >= NEAREST_KEPT) {
      const oldest = this.#nearestKept.keys().next();
      if (oldest.done !== true) this.#nearestKept.delete(oldest.value);
    }
    this.#nearestKept.set(square, { goal: [point[0], point[1], point[2]], near: best });
    return best;
  }

  /** nearestSteps at once (made whole first, however long it takes). */
  nearest(point: Vec3): IslandPoint {
    const steps = this.nearestSteps(point, { allowance: Infinity, taken: 0 });
    const step = steps.next();
    if (step.done !== true) throw new Error('navmesh island: nearest point gave way unbounded');
    return step.value;
  }
}

/**
 * The islands made for a set: each triangle's (the last one made that reaches it), and the one
 * being made. One is made at a time: a search whose triangle it has not reached yet makes it on
 * (its triangle may be on it) rather than make another over the same triangles beside it.
 */
interface SetIslands {
  readonly slots: WeakMap<Navmesh, (NavmeshIsland | undefined)[]>;
  making: NavmeshIsland | undefined;
}

const ISLANDS = new WeakMap<NavmeshLookup, SetIslands>();

function islandsOf(set: NavmeshLookup): SetIslands {
  let islands = ISLANDS.get(set);
  if (!islands) {
    islands = { slots: new WeakMap(), making: undefined };
    ISLANDS.set(set, islands);
  }
  return islands;
}

/**
 * Makes on the island a triangle of a set lies in, as far as `share` gives (each triangle
 * flooded takes one): the island that has reached the triangle (whole or not yet: `complete`),
 * or undefined while the island being made has not reached it. An island made whole is kept
 * while it holds. The set makes one island at a time, so searches begun together on one stretch
 * of navmesh flood it once: while the island being made has not reached a triangle, it is made
 * on first (the triangle is found on it, or once it is whole without it, the triangle's own is
 * begun).
 */
export function growIsland(
  set: NavmeshLookup,
  navmesh: Navmesh,
  triangle: number,
  share: IslandShare,
): NavmeshIsland | undefined {
  const islands = islandsOf(set);
  const known = islands.slots.get(navmesh)?.[triangle];
  if (known?.has(navmesh, triangle) && known.current(set)) {
    if (!known.complete) known.grow(share);
    return known;
  }
  const making = islands.making;
  if (making && !making.complete && making.current(set)) {
    const whole = making.grow(share);
    if (making.has(navmesh, triangle)) return making;
    if (!whole) return undefined;
  }
  // Every triangle it reaches finds it next time (a later island reaching one takes its place).
  const island = new NavmeshIsland(set, navmesh, triangle, islands.slots);
  islands.making = island;
  island.grow(share);
  return island;
}

/** The island a triangle of a set lies in, made whole at once (growIsland unbounded). */
export function islandOf(set: NavmeshLookup, navmesh: Navmesh, triangle: number): NavmeshIsland {
  for (;;) {
    const island = growIsland(set, navmesh, triangle, { allowance: Infinity, taken: 0 });
    if (island?.complete === true) return island;
  }
}

/** The island a triangle of a set lies in if one is made whole and holds, else undefined. */
export function islandKnown(
  set: NavmeshLookup,
  navmesh: Navmesh,
  triangle: number,
): NavmeshIsland | undefined {
  const known = ISLANDS.get(set)?.slots.get(navmesh)?.[triangle];
  return known?.complete === true && known.current(set) && known.has(navmesh, triangle)
    ? known
    : undefined;
}

/** The point of triangle abc nearest p (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]] as const;
  const dot = (u: readonly number[], v: readonly number[]): number =>
    (u[0] ?? 0) * (v[0] ?? 0) + (u[1] ?? 0) * (v[1] ?? 0) + (u[2] ?? 0) * (v[2] ?? 0);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]] as const;
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v];
  }
  const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]] as const;
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w];
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}
