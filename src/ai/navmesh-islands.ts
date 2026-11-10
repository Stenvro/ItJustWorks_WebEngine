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

/** The islands of a set's triangles: each marked triangle's flood (the last that marked it). */
type Slots = WeakMap<Navmesh, (Flood | undefined)[]>;

/**
 * A flood of triangles from one triangle, a share at a time: the part of an island one search
 * began. Floods begun apart on one stretch of navmesh meet and are one island from then on (a
 * flood leaves a triangle another part of its island has marked to that part).
 */
class Flood {
  /** Each navmesh it reaches, by form id, and the triangles it reaches of it. */
  readonly reached = new Map<
    number,
    { readonly navmesh: Navmesh; readonly triangles: Uint8Array }
  >();
  /** Navmeshes its links lead into that were not loaded as it was made. */
  readonly missing = new Set<number>();
  /**
   * The triangles marked but not yet flooded from (each: its navmesh and index), flooded from in
   * the order marked from `openHead` on: outward from the first, so a triangle near it is found
   * early (a search asks whether its goal is on the island while it is made).
   */
  openMesh: Navmesh[] = [];
  openTriangle: number[] = [];
  openHead = 0;
  /**
   * Its triangles by the grid squares their bounds cover (indices into the two lists below), and
   * the heights they span in each.
   */
  readonly grid = new Map<number, GridSquare>();
  readonly gridMesh: Navmesh[] = [];
  readonly gridTriangle: number[] = [];
  /** The grid squares it covers, and the heights. */
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;
  minZ = Infinity;
  maxZ = -Infinity;
  /** How many triangles it marked. */
  size = 0;
  /** The island it is part of. */
  island: NavmeshIsland;

  constructor(island: NavmeshIsland) {
    this.island = island;
  }

  /** Whether it has flooded from every triangle it marked. */
  get whole(): boolean {
    return this.openHead >= this.openMesh.length;
  }

  /** The last navmesh marked in: its reached triangles. */
  #lastMesh: Navmesh | undefined;
  #lastTriangles: Uint8Array | undefined;

  /** The reached triangles of a navmesh (made on the first). */
  trianglesOf(into: Navmesh): Uint8Array {
    if (into === this.#lastMesh && this.#lastTriangles) return this.#lastTriangles;
    let entry = this.reached.get(into.formId);
    if (!entry) {
      entry = { navmesh: into, triangles: new Uint8Array(into.triangles.length) };
      this.reached.set(into.formId, entry);
    }
    this.#lastMesh = into;
    this.#lastTriangles = entry.triangles;
    return entry.triangles;
  }

  has(navmesh: Navmesh, triangle: number): boolean {
    const entry = this.reached.get(navmesh.formId);
    return entry?.navmesh === navmesh && entry.triangles[triangle] === 1;
  }

  /** Marks a triangle to flood from (once). */
  mark(into: Navmesh, index: number, slots: (Flood | undefined)[] | undefined): void {
    const triangles = this.trianglesOf(into);
    if (triangles[index] === 1) return;
    triangles[index] = 1;
    this.size++;
    this.openMesh.push(into);
    this.openTriangle.push(index);
    if (slots) slots[index] = this;
  }

  /** Its grid: the triangle in each square its horizontal bounds cover. */
  index(navmesh: Navmesh, index: number): void {
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
    const id = this.gridMesh.length;
    this.gridMesh.push(navmesh);
    this.gridTriangle.push(index);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const key = gridKey(gx, gy);
        const square = this.grid.get(key);
        if (square) {
          square.ids.push(id);
          if (z0 < square.minZ) square.minZ = z0;
          if (z1 > square.maxZ) square.maxZ = z1;
        } else this.grid.set(key, { ids: [id], minZ: z0, maxZ: z1 });
      }
    }
    if (x0 < this.minX) this.minX = x0;
    if (x1 > this.maxX) this.maxX = x1;
    if (y0 < this.minY) this.minY = y0;
    if (y1 > this.maxY) this.maxY = y1;
    if (z0 < this.minZ) this.minZ = z0;
    if (z1 > this.maxZ) this.maxZ = z1;
  }

  /** Looks at a grid square's triangles for a nearer point (the square and each take one). */
  *look(gx: number, gy: number, query: NearestQuery): Generator<undefined, void, undefined> {
    if (gx < this.minX || gx > this.maxX || gy < this.minY || gy > this.maxY) return;
    const { point, share, looked } = query;
    if (share.taken >= share.allowance) yield;
    share.taken++;
    const square = this.grid.get(gridKey(gx, gy));
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
      const navmesh = this.gridMesh[id];
      const index = this.gridTriangle[id];
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

  /** Its point nearer `point` than the query's best, if any (its grid's squares outward). */
  *nearer(cx: number, cy: number, query: NearestQuery): Generator<undefined, void, undefined> {
    if (this.gridMesh.length === 0) return;
    const point = query.point;
    query.looked.clear();
    // The rings of squares round the point's that reach its squares.
    const outside = Math.max(this.minX - cx, cx - this.maxX, this.minY - cy, cy - this.maxY);
    const first = Math.max(0, outside);
    const last = Math.max(
      Math.abs(cx - this.minX),
      Math.abs(cx - this.maxX),
      Math.abs(cy - this.minY),
      Math.abs(cy - this.maxY),
    );
    // No point of it lies nearer in height than its heights' span.
    const dz = Math.max(this.minZ - point[2], 0, point[2] - this.maxZ);
    for (let ring = first; ring <= last; ring++) {
      // Every point of a square `ring` squares out lies at least ring - 1 squares away.
      const across = Math.max(0, ring - 1) * GRID;
      if (query.best && query.bestD <= across * across + dz * dz) break;
      if (ring === 0) {
        yield* this.look(cx, cy, query);
        continue;
      }
      const x0 = Math.max(cx - ring, this.minX);
      const x1 = Math.min(cx + ring, this.maxX);
      for (let gx = x0; gx <= x1; gx++) {
        yield* this.look(gx, cy - ring, query);
        yield* this.look(gx, cy + ring, query);
      }
      const y0 = Math.max(cy - ring + 1, this.minY);
      const y1 = Math.min(cy + ring - 1, this.maxY);
      for (let gy = y0; gy <= y1; gy++) {
        yield* this.look(cx - ring, gy, query);
        yield* this.look(cx + ring, gy, query);
      }
    }
  }
}

/**
 * The triangles reached from one triangle over the edges and the links a search crosses (one
 * way: a ledge down is crossed, its foot need not lead back up). Made a share at a time (`grow`)
 * and kept while the navmeshes it was made of are the loaded ones and none it led into but found
 * unloaded has loaded since.
 *
 * Searches begun apart on one stretch of navmesh (soldiers round a dragon) each begin a flood
 * from their own triangle; where one reaches a triangle another island being made (or made) has
 * marked, the two are one island from then on, each flood going on outward from where it is, so
 * the stretch is flooded once. One begun on a stretch of its own (a tower's top, a ledge) floods
 * only that. Joined over a one-way link, the island also holds what only the other's start
 * reaches: a goal there is taken for on it and searched for as before islands, never taken for
 * off it wrongly. In the load order's 19,201 navmeshes every ledge link (2,350 up, 2,350 down)
 * has its reverse and all but 66 of the 229,170 portals do, so a join is almost always exact.
 */
export class NavmeshIsland {
  /** Its floods: the first begun from its own triangle, then those of islands it joined. */
  readonly #parts: Flood[] = [];
  /** The first of its floods not yet whole (those before are). */
  #growing = 0;
  /** The island it was joined into, once joined (it goes by that one from then on). */
  #into: NavmeshIsland | undefined;
  /** Once found not to hold (it never holds again). */
  #lapsed = false;
  /** The nearest points lately asked for, by the goal's grid square (gridKey), the goal kept. */
  readonly #nearestKept = new Map<number, { readonly goal: Vec3; readonly near: IslandPoint }>();
  readonly #set: NavmeshLookup;
  readonly #slots: Slots | undefined;

  /**
   * `slots`: the set's triangles' floods (each triangle a flood marks finds it there, so a search
   * begun on one while it is being made goes on making it, and floods that meet are joined).
   */
  constructor(set: NavmeshLookup, navmesh: Navmesh, triangle: number, slots?: Slots) {
    this.#set = set;
    this.#slots = slots;
    const flood = new Flood(this);
    this.#parts.push(flood);
    flood.mark(navmesh, triangle, this.#slotsOf(navmesh));
  }

  /** The island it is now (itself, or the one it was joined into). */
  get #root(): NavmeshIsland {
    let root = this.#into;
    if (!root) return this;
    while (root.#into) root = root.#into;
    // The way shortened for the next time.
    this.#into = root;
    return root;
  }

  #slotsOf(into: Navmesh): (Flood | undefined)[] | undefined {
    const slots = this.#slots;
    if (!slots) return undefined;
    let own = slots.get(into);
    if (!own) {
      own = new Array<Flood | undefined>(into.triangles.length).fill(undefined);
      slots.set(into, own);
    }
    return own;
  }

  /** Whether it is made whole (every triangle it reaches found). */
  get complete(): boolean {
    const root = this.#root;
    for (let i = root.#growing; i < root.#parts.length; i++) {
      if (!root.#parts[i]?.whole) return false;
    }
    return true;
  }

  /** How many triangles it reaches (so far, while it is being made). */
  get size(): number {
    let size = 0;
    for (const part of this.#root.#parts) size += part.size;
    return size;
  }

  /** Joins another island into it: its floods are this one's from now on. */
  #join(other: NavmeshIsland): void {
    for (const part of other.#parts) {
      part.island = this;
      this.#parts.push(part);
    }
    other.#parts.length = 0;
    other.#into = this;
    // Points nearer than those kept may lie on what it joined.
    this.#nearestKept.clear();
  }

  /**
   * Floods on from the triangles marked until it is whole or `share` is spent (each triangle
   * flooded from takes one); whether it is whole.
   */
  grow(share: IslandShare): boolean {
    const root = this.#root;
    if (root !== this) return root.grow(share);
    const parts = this.#parts;
    for (;;) {
      const part = parts[this.#growing];
      if (!part) return true;
      if (part.whole) {
        // Whole: its lists let go.
        part.openMesh = [];
        part.openTriangle = [];
        part.openHead = 0;
        this.#growing++;
        continue;
      }
      if (share.taken >= share.allowance) return false;
      share.taken++;
      const at = part.openMesh[part.openHead];
      const index = part.openTriangle[part.openHead];
      part.openHead++;
      if (!at || index === undefined) continue;
      part.index(at, index);
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
            part.missing.add(across.navmesh);
            continue;
          }
          into = loaded;
          target = across.triangle;
        }
        const t = into.triangles[target];
        if (!t || (t.flags & NavmeshFlag.deleted) !== 0) continue;
        if (part.trianglesOf(into)[target] === 1) continue;
        const slots = this.#slotsOf(into);
        const marked = slots?.[target];
        if (marked && marked !== part) {
          const other = marked.island.#root;
          // Another part of it has the triangle: that part floods from it.
          if (other === this) continue;
          // Another island that holds has it: one island from now on.
          if (other.current(this.#set)) {
            this.#join(other);
            continue;
          }
        }
        part.mark(into, target, slots);
      }
    }
  }

  /** Whether it reaches a triangle (of those found so far, while it is being made). */
  has(navmesh: Navmesh, triangle: number): boolean {
    for (const part of this.#root.#parts) if (part.has(navmesh, triangle)) return true;
    return false;
  }

  /** Whether it still holds: its navmeshes are the loaded ones, none it lacked has loaded. */
  current(set: NavmeshLookup): boolean {
    const root = this.#root;
    if (root.#lapsed) return false;
    for (const part of root.#parts) {
      for (const [formId, entry] of part.reached) {
        if (set.navmesh(formId) !== entry.navmesh) {
          root.#lapsed = true;
          return false;
        }
      }
      for (const formId of part.missing) {
        if (set.navmesh(formId)) {
          root.#lapsed = true;
          return false;
        }
      }
    }
    return true;
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
    const root = this.#root;
    if (root !== this) return yield* root.nearestSteps(point, share);
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
    // Each flood's grid in turn, the best so far bounding the look at the next.
    for (const part of this.#parts) yield* part.nearer(cx, cy, query);
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

  /** The island a triangle's flood is part of now (for the set's lookups below). */
  static of(flood: Flood): NavmeshIsland {
    return flood.island.#root;
  }
}

/** The floods made for each set: each triangle's (the last that marked it). */
const ISLANDS = new WeakMap<NavmeshLookup, Slots>();

function slotsOf(set: NavmeshLookup): Slots {
  let slots = ISLANDS.get(set);
  if (!slots) {
    slots = new WeakMap();
    ISLANDS.set(set, slots);
  }
  return slots;
}

/**
 * Makes on the island a triangle of a set lies in, as far as `share` gives (each triangle
 * flooded takes one), and gives it (whole or not yet: `complete`): the island that has reached
 * the triangle, made on while it holds, or else one begun from the triangle. Begun beside
 * another being made on the same stretch, the two are joined where their floods meet, so the
 * stretch is flooded once; one on a stretch of its own floods only that, in the share it began.
 */
export function growIsland(
  set: NavmeshLookup,
  navmesh: Navmesh,
  triangle: number,
  share: IslandShare,
): NavmeshIsland {
  const slots = slotsOf(set);
  const flood = slots.get(navmesh)?.[triangle];
  if (flood) {
    const known = NavmeshIsland.of(flood);
    if (known.current(set)) {
      if (!known.complete) known.grow(share);
      return NavmeshIsland.of(flood);
    }
  }
  // Every triangle it reaches finds it next time (a later island reaching one takes its place).
  const island = new NavmeshIsland(set, navmesh, triangle, slots);
  island.grow(share);
  return island;
}

/** The island a triangle of a set lies in, made whole at once (growIsland unbounded). */
export function islandOf(set: NavmeshLookup, navmesh: Navmesh, triangle: number): NavmeshIsland {
  for (;;) {
    const island = growIsland(set, navmesh, triangle, { allowance: Infinity, taken: 0 });
    if (island.complete) return island;
  }
}

/** The island a triangle of a set lies in if one is made whole and holds, else undefined. */
export function islandKnown(
  set: NavmeshLookup,
  navmesh: Navmesh,
  triangle: number,
): NavmeshIsland | undefined {
  const flood = ISLANDS.get(set)?.get(navmesh)?.[triangle];
  if (!flood) return undefined;
  const known = NavmeshIsland.of(flood);
  return known.complete && known.current(set) ? known : undefined;
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
