// The islands of a set of navigation meshes: the triangles a search can reach from a triangle,
// over its edges and the edge links a search crosses (portals, ledges), whatever the searcher's
// options (they only close more). A goal outside the island a search begins in cannot be
// reached however long it searches; findPath goes to the island's point nearest the goal
// instead of searching the whole island for it (src/ai/pathfinding.ts, docs/ai.md "Paths").

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

/**
 * The triangles reached from one triangle over the edges and the links a search crosses (one
 * way: a ledge down is crossed, its foot need not lead back up). Kept while the navmeshes it was
 * made of are the loaded ones and none it led into but found unloaded has loaded since.
 */
export class NavmeshIsland {
  /** Each navmesh it reaches, by form id, and the triangles it reaches of it. */
  readonly #reached = new Map<
    number,
    { readonly navmesh: Navmesh; readonly triangles: Uint8Array }
  >();
  /** Navmeshes its links lead into that were not loaded as it was made. */
  readonly #missing = new Set<number>();
  /** How many triangles it reaches. */
  readonly size: number;

  constructor(set: NavmeshLookup, navmesh: Navmesh, triangle: number) {
    const open: [Navmesh, number][] = [[navmesh, triangle]];
    let size = 0;
    const mark = (into: Navmesh, index: number): boolean => {
      let entry = this.#reached.get(into.formId);
      if (!entry) {
        entry = { navmesh: into, triangles: new Uint8Array(into.triangles.length) };
        this.#reached.set(into.formId, entry);
      }
      if (entry.triangles[index] === 1) return false;
      entry.triangles[index] = 1;
      size++;
      return true;
    };
    mark(navmesh, triangle);
    for (let next = open.pop(); next; next = open.pop()) {
      const [at, index] = next;
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
          const loaded = set.navmesh(across.navmesh);
          if (!loaded) {
            this.#missing.add(across.navmesh);
            continue;
          }
          into = loaded;
          target = across.triangle;
        }
        const t = into.triangles[target];
        if (!t || (t.flags & NavmeshFlag.deleted) !== 0) continue;
        if (mark(into, target)) open.push([into, target]);
      }
    }
    this.size = size;
  }

  /** The navmeshes it reaches and, of each, which triangles (1: reached). */
  *navmeshes(): Generator<readonly [Navmesh, Uint8Array]> {
    for (const { navmesh, triangles } of this.#reached.values()) yield [navmesh, triangles];
  }

  /** Whether it reaches a triangle. */
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

  /** Its point nearest to `point` (straight, in 3D), and the triangle it lies in. */
  nearest(point: Vec3): {
    readonly at: Vec3;
    readonly navmesh: Navmesh;
    readonly triangle: number;
  } {
    let best: { at: Vec3; navmesh: Navmesh; triangle: number } | undefined;
    let bestD = Infinity;
    for (const { navmesh, triangles } of this.#reached.values()) {
      for (let index = 0; index < triangles.length; index++) {
        if (triangles[index] !== 1) continue;
        const [a, b, c] = navmeshTriangle(navmesh, index);
        const at = closestOnTriangle(point, a, b, c);
        const d = (at[0] - point[0]) ** 2 + (at[1] - point[1]) ** 2 + (at[2] - point[2]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { at, navmesh, triangle: index };
        }
      }
    }
    // An island reaches at least the triangle it was made from.
    if (!best) throw new Error('navmesh island without triangles');
    return best;
  }
}

/** The islands made for a set (each triangle: the last one made that reaches it). */
const ISLANDS = new WeakMap<NavmeshLookup, WeakMap<Navmesh, (NavmeshIsland | undefined)[]>>();

/** The island a triangle of a set lies in (made once, kept while it holds). */
export function islandOf(set: NavmeshLookup, navmesh: Navmesh, triangle: number): NavmeshIsland {
  let byNavmesh = ISLANDS.get(set);
  if (!byNavmesh) {
    byNavmesh = new WeakMap();
    ISLANDS.set(set, byNavmesh);
  }
  let slots = byNavmesh.get(navmesh);
  if (!slots) {
    slots = [];
    byNavmesh.set(navmesh, slots);
  }
  const known = slots[triangle];
  if (known?.current(set) && known.has(navmesh, triangle)) return known;
  const island = new NavmeshIsland(set, navmesh, triangle);
  // Every triangle it reaches finds it next time (a later island reaching one takes its place).
  for (const [mesh, marks] of island.navmeshes()) {
    let own = byNavmesh.get(mesh);
    if (!own) {
      own = [];
      byNavmesh.set(mesh, own);
    }
    for (let index = 0; index < marks.length; index++) if (marks[index] === 1) own[index] = island;
  }
  return island;
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
