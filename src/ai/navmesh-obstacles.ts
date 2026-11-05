// Navmesh obstacles (docs/ai.md, "Navmesh obstacles"): references whose base carries record
// flag bit 25 cut the navmesh under them while they are enabled and shut (a quest's collision
// box, a portcullis, a retractable bridge). An obstacle's box is its reference's collision bounds
// (a collision marker's primitive, else the base's OBND), scaled and rotated by the reference;
// its footprint is the box's outline seen from above, and it cuts only when the box is tall
// enough. A navmesh point counts as under it when its height lies within a band from below the
// box's bottom to just under its top, both taken straight above or below the point (a tilted
// box's faces, not its upright bounds). Platform-independent.
//
// The engine re-triangulates the cut navmesh (BSNavmeshObstacleData per triangle, undone by
// BSNavmeshObstacleUndoData): a triangle partly covered is split and its free part stays open.
// Ours cuts the same ground out of a triangle as a path search comes to it (freeParts): convex
// parts instead of new triangles, the search going from part to part.

type Vec3 = readonly [number, number, number];
type Vec2 = readonly [number, number];

/** fObstacleManagerMinHeight: a box half this tall never cuts; twice it always does. */
export const OBSTACLE_MIN_HEIGHT = 48;
/** fObstacleManagerMinWidth: a box at least this wide cuts once it is MIN_HEIGHT tall. */
export const OBSTACLE_MIN_WIDTH = 16;
/** fMaxHeightFromNavmeshToObstacleBoxBottom: the navmesh this far below the box's bottom is cut. */
export const NAVMESH_BELOW_OBSTACLE = 128;
/** fMaxHeightFromObstacleBoxToToNavmesh: the navmesh up to the box's top plus this is cut. */
export const NAVMESH_ABOVE_OBSTACLE = -16;

/** An obstacle's box as placed: its reference's placement (column-major) and its local bounds. */
export interface ObstacleBox {
  readonly reference: number;
  /** The reference's placement with its scale (column-major 4×4). */
  readonly world: ArrayLike<number>;
  readonly min: Vec3;
  readonly max: Vec3;
}

/** An obstacle's cut: its footprint seen from above and the heights of navmesh it cuts. */
export interface NavmeshObstacle {
  readonly reference: number;
  /** The footprint: a convex outline, counter-clockwise. */
  readonly outline: readonly Vec2[];
  /** The navmesh between these heights under the footprint is cut (the most it can be). */
  readonly low: number;
  readonly high: number;
  /** The footprint's bounds. */
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  /**
   * The box itself: from world to its own frame (a 3×3 row by row, then the frame's origin in
   * the world) and its bounds there. Each point of the footprint has its own band: the box's
   * bottom and top straight above or below it (a tilted slab under a ramp's navmesh).
   */
  readonly box: {
    readonly toLocal: readonly number[];
    readonly origin: Vec3;
    readonly min: Vec3;
    readonly max: Vec3;
  };
}

/** The convex hull of points (Andrew's monotone chain), counter-clockwise. */
function hull(points: readonly Vec2[]): Vec2[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length <= 2) return sorted;
  const turn = (o: Vec2, a: Vec2, b: Vec2): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && turn(lower.at(-2) ?? point, lower.at(-1) ?? point, point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: Vec2[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const point = sorted[i] ?? sorted[0] ?? [0, 0];
    while (upper.length >= 2 && turn(upper.at(-2) ?? point, upper.at(-1) ?? point, point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/** A convex outline's least width (the narrowest of its widths across each edge). */
function leastWidth(outline: readonly Vec2[]): number {
  let least = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    if (!a || !b) continue;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 1e-6) continue;
    let widest = 0;
    for (const point of outline) {
      const across = Math.abs(
        (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]),
      );
      widest = Math.max(widest, across / length);
    }
    least = Math.min(least, widest);
  }
  return Number.isFinite(least) ? least : 0;
}

/**
 * An obstacle box's cut (undefined: it cuts nothing). It cuts when it is at least twice
 * fObstacleManagerMinHeight tall, or at least that tall and fObstacleManagerMinWidth wide.
 */
export function obstacleCut(box: ObstacleBox): NavmeshObstacle | undefined {
  const m = box.world;
  const at = (i: number): number => m[i] ?? 0;
  const corners: Vec3[] = [];
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const z of [box.min[2], box.max[2]]) {
        corners.push([
          at(0) * x + at(4) * y + at(8) * z + at(12),
          at(1) * x + at(5) * y + at(9) * z + at(13),
          at(2) * x + at(6) * y + at(10) * z + at(14),
        ]);
      }
    }
  }
  const bottom = Math.min(...corners.map((corner) => corner[2]));
  const top = Math.max(...corners.map((corner) => corner[2]));
  const outline = hull(corners.map((corner) => [corner[0], corner[1]] as Vec2));
  if (outline.length < 3) return undefined;
  const height = top - bottom;
  const width = leastWidth(outline);
  const tall =
    height >= 2 * OBSTACLE_MIN_HEIGHT ||
    (height >= OBSTACLE_MIN_HEIGHT && width >= OBSTACLE_MIN_WIDTH);
  if (!tall) return undefined;
  const xs = outline.map((point) => point[0]);
  const ys = outline.map((point) => point[1]);
  // The placement's 3×3 (with its scale) inverted: world to the box's own frame.
  const [a, b, c, d, e, f, g, h, k] = [
    at(0),
    at(4),
    at(8),
    at(1),
    at(5),
    at(9),
    at(2),
    at(6),
    at(10),
  ];
  const det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-9) return undefined;
  const toLocal = [
    (e * k - f * h) / det,
    (c * h - b * k) / det,
    (b * f - c * e) / det,
    (f * g - d * k) / det,
    (a * k - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
  return {
    reference: box.reference,
    outline,
    low: bottom - NAVMESH_BELOW_OBSTACLE,
    high: top + NAVMESH_ABOVE_OBSTACLE,
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
    box: { toLocal, origin: [at(12), at(13), at(14)], min: box.min, max: box.max },
  };
}

/**
 * The heights the box spans straight above or below a point of its footprint (undefined: the
 * vertical line there misses it): each of its own axes keeps the line within its bounds.
 */
function columnOf(obstacle: NavmeshObstacle, x: number, y: number): [number, number] | undefined {
  const { toLocal, origin, min, max } = obstacle.box;
  let bottom = -Infinity;
  let top = Infinity;
  for (let i = 0; i < 3; i++) {
    // Along the axis, the line is at `from + rate · z`.
    const rate = toLocal[i * 3 + 2] ?? 0;
    const from =
      (toLocal[i * 3] ?? 0) * (x - origin[0]) +
      (toLocal[i * 3 + 1] ?? 0) * (y - origin[1]) -
      rate * origin[2];
    const lo = min[i] ?? 0;
    const hi = max[i] ?? 0;
    if (Math.abs(rate) < 1e-9) {
      if (from < lo || from > hi) return undefined;
      continue;
    }
    const z0 = (lo - from) / rate;
    const z1 = (hi - from) / rate;
    bottom = Math.max(bottom, Math.min(z0, z1));
    top = Math.min(top, Math.max(z0, z1));
  }
  return bottom <= top ? [bottom, top] : undefined;
}

/**
 * Whether a point lies under an obstacle: in its footprint (seen from above), at a height it
 * cuts there (from below the box's bottom straight under it to just under its top straight over
 * it: a navmesh on a tilted slab's upper face is not under it).
 */
export function underObstacle(obstacle: NavmeshObstacle, point: Vec3): boolean {
  if (point[2] < obstacle.low || point[2] > obstacle.high) return false;
  if (!insideOutline(obstacle, point[0], point[1])) return false;
  const column = columnOf(obstacle, point[0], point[1]);
  return (
    column !== undefined &&
    point[2] >= column[0] - NAVMESH_BELOW_OBSTACLE &&
    point[2] <= column[1] + NAVMESH_ABOVE_OBSTACLE
  );
}

function insideOutline(obstacle: NavmeshObstacle, x: number, y: number): boolean {
  if (x < obstacle.minX || x > obstacle.maxX || y < obstacle.minY || y > obstacle.maxY) {
    return false;
  }
  const outline = obstacle.outline;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    if (!a || !b) continue;
    if ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) return false;
  }
  return true;
}

/**
 * Whether a path step from `a` to `b` crosses an obstacle's footprint at a height it cuts. A step
 * that begins inside one does not count (an actor standing in a box walks out of it).
 */
export function crossesObstacle(obstacle: NavmeshObstacle, a: Vec3, b: Vec3): boolean {
  if (Math.max(a[2], b[2]) < obstacle.low || Math.min(a[2], b[2]) > obstacle.high) return false;
  if (Math.max(a[0], b[0]) < obstacle.minX || Math.min(a[0], b[0]) > obstacle.maxX) return false;
  if (Math.max(a[1], b[1]) < obstacle.minY || Math.min(a[1], b[1]) > obstacle.maxY) return false;
  if (insideOutline(obstacle, a[0], a[1])) return false;
  // Clipped against each edge's half-plane (Cyrus–Beck): what is left lies inside.
  let enter = 0;
  let leave = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const outline = obstacle.outline;
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i];
    const q = outline[(i + 1) % outline.length];
    if (!p || !q) continue;
    // Inside: (q − p) × (point − p) ≥ 0.
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    const start = ex * (a[1] - p[1]) - ey * (a[0] - p[0]);
    const rate = ex * dy - ey * dx;
    if (Math.abs(rate) < 1e-12) {
      if (start < 0) return false;
      continue;
    }
    const t = -start / rate;
    if (rate > 0) enter = Math.max(enter, t);
    else leave = Math.min(leave, t);
    if (enter > leave) return false;
  }
  // Over the footprint, it is under the box somewhere: its height against the box's band there,
  // from where it comes over the footprint to where it leaves (or ends).
  for (let k = 0; k <= CROSSING_SAMPLES; k++) {
    const t = enter + ((leave - enter) * k) / CROSSING_SAMPLES;
    if (underObstacle(obstacle, [a[0] + dx * t, a[1] + dy * t, a[2] + (b[2] - a[2]) * t])) {
      return true;
    }
  }
  return false;
}

/** A step's stretch over a footprint is tested at this many points and one. */
const CROSSING_SAMPLES = 4;

/** A half-plane seen from above: a·x + b·y + c ≥ 0. */
type HalfPlane = readonly [number, number, number];

/** A part of a triangle thinner than this (square units) is no part. */
const LEAST_PART_AREA = 1;

/**
 * The half-planes whose common part is what an obstacle cuts of a triangle's plane (`z` at x,y:
 * z0 + zx·x + zy·y): inside the footprint, not below the box's bottom straight above it by more
 * than the band, nor above its top straight below it (underObstacle). Each of the box's faces is
 * a plane, so each limit is a straight line across the triangle: what is cut is convex.
 */
function cutPlanes(obstacle: NavmeshObstacle, z0: number, zx: number, zy: number): HalfPlane[] {
  const planes: HalfPlane[] = [];
  const outline = obstacle.outline;
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i];
    const q = outline[(i + 1) % outline.length];
    if (!p || !q) continue;
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    planes.push([-ey, ex, ey * p[0] - ex * p[1]]);
  }
  const { toLocal, origin, min, max } = obstacle.box;
  for (let i = 0; i < 3; i++) {
    const lx = toLocal[i * 3] ?? 0;
    const ly = toLocal[i * 3 + 1] ?? 0;
    const rate = toLocal[i * 3 + 2] ?? 0;
    // Along this axis, a point of the vertical line is at fx·x + fy·y + f + rate·z.
    const f = -lx * origin[0] - ly * origin[1] - rate * origin[2];
    if (Math.abs(rate) < 1e-9) continue; // The footprint's outline holds it.
    const lo = min[i] ?? 0;
    const hi = max[i] ?? 0;
    // The face the line leaves the box by at its bottom, and at its top: z = (v − f − …) / rate.
    const face = (v: number): HalfPlane => [-lx / rate, -ly / rate, (v - f) / rate];
    const [bottom, top] = rate > 0 ? [face(lo), face(hi)] : [face(hi), face(lo)];
    // z + below − bottom ≥ 0.
    planes.push([zx - bottom[0], zy - bottom[1], z0 + NAVMESH_BELOW_OBSTACLE - bottom[2]]);
    // top + above − z ≥ 0.
    planes.push([top[0] - zx, top[1] - zy, top[2] + NAVMESH_ABOVE_OBSTACLE - z0]);
  }
  return planes;
}

/** A convex outline's part on one side of a half-plane's line (`inside`: the plane's side). */
function clipped(polygon: readonly Vec2[], plane: HalfPlane, inside: boolean): Vec2[] {
  const sign = inside ? 1 : -1;
  const out: Vec2[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i];
    const q = polygon[(i + 1) % polygon.length];
    if (!p || !q) continue;
    const sp = sign * (plane[0] * p[0] + plane[1] * p[1] + plane[2]);
    const sq = sign * (plane[0] * q[0] + plane[1] * q[1] + plane[2]);
    if (sp >= 0) out.push(p);
    if (sp >= 0 !== sq >= 0) {
      const t = sp / (sp - sq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

function outlineArea(polygon: readonly Vec2[]): number {
  let twice = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i];
    const q = polygon[(i + 1) % polygon.length];
    if (p && q) twice += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(twice) / 2;
}

/** A convex part less what the half-planes' common part covers (itself if that misses it). */
function withoutCut(part: readonly Vec2[], planes: readonly HalfPlane[]): readonly Vec2[][] {
  const free: Vec2[][] = [];
  let rest: readonly Vec2[] = part;
  for (const plane of planes) {
    const outside = clipped(rest, plane, false);
    if (outlineArea(outside) >= LEAST_PART_AREA) free.push(outside);
    rest = clipped(rest, plane, true);
    if (outlineArea(rest) < LEAST_PART_AREA) return [[...part]];
  }
  return free;
}

/**
 * What the obstacles leave of a navmesh triangle, as the engine's cut leaves it: convex parts
 * (outlines with their heights on the triangle's plane), none where it lies wholly under them;
 * undefined where they cut nothing of it. The original lays new triangles over the free part;
 * these parts cover the same ground.
 */
export function freeParts(
  [a, b, c]: readonly [Vec3, Vec3, Vec3],
  obstacles: Iterable<NavmeshObstacle>,
): readonly (readonly Vec3[])[] | undefined {
  // The triangle's plane; one standing on edge (no such walkable triangle) is not cut.
  const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
  const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
  const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(nz) < 1e-6) return undefined;
  const zx = -nx / nz;
  const zy = -ny / nz;
  const z0 = a[2] - zx * a[0] - zy * a[1];
  const whole: Vec2[] = [
    [a[0], a[1]],
    [b[0], b[1]],
    [c[0], c[1]],
  ];
  let parts: readonly (readonly Vec2[])[] = [whole];
  let cut = false;
  for (const obstacle of obstacles) {
    const planes = cutPlanes(obstacle, z0, zx, zy);
    const next: (readonly Vec2[])[] = [];
    for (const part of parts) {
      const free = withoutCut(part, planes);
      if (free.length !== 1 || (free[0] ?? []).length !== part.length || free[0]?.[0] !== part[0]) {
        cut = true;
      }
      next.push(...free);
    }
    parts = next;
  }
  if (!cut) return undefined;
  return parts.map((part) => part.map(([x, y]) => [x, y, z0 + zx * x + zy * y] as const));
}

/** Whether a point lies inside a convex outline, seen from above. */
export function insidePart(part: readonly Vec3[], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < part.length; i++) {
    const p = part[i];
    const q = part[(i + 1) % part.length];
    if (!p || !q) continue;
    const side = (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
    if (Math.abs(side) < 1e-6) continue;
    if (sign === 0) sign = Math.sign(side);
    else if (Math.sign(side) !== sign) return false;
  }
  return true;
}

/**
 * The stretch (shares of `a` to `b`) of the line through them along which a convex part lies,
 * its corners within `tolerance` of the line, seen from above; undefined if it only touches.
 */
export function partSpan(
  part: readonly Vec3[],
  a: Vec3,
  b: Vec3,
  tolerance: number,
): readonly [number, number] | undefined {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  if (length2 < 1e-9) return undefined;
  const length = Math.sqrt(length2);
  let from = Infinity;
  let to = -Infinity;
  for (const point of part) {
    const rx = point[0] - a[0];
    const ry = point[1] - a[1];
    if (Math.abs(dx * ry - dy * rx) / length > tolerance) continue;
    const t = (rx * dx + ry * dy) / length2;
    from = Math.min(from, t);
    to = Math.max(to, t);
  }
  const start = Math.max(0, from);
  const end = Math.min(1, to);
  return (end - start) * length >= LEAST_GATE ? [start, end] : undefined;
}

/** A stretch of an edge shorter than this (units) is no way through. */
const LEAST_GATE = 0.5;

/** Obstacles bucketed on a grid (a path search asks only those near each step). */
export class ObstacleIndex {
  static readonly #SIZE = 512;
  readonly #buckets = new Map<number, NavmeshObstacle[]>();
  /** What the obstacles leave of each triangle looked at (`null`: all of it). */
  readonly #parts = new Map<object, Map<number, readonly (readonly Vec3[])[] | null>>();

  constructor(obstacles: readonly NavmeshObstacle[]) {
    const size = ObstacleIndex.#SIZE;
    for (const obstacle of obstacles) {
      for (
        let gx = Math.floor(obstacle.minX / size);
        gx <= Math.floor(obstacle.maxX / size);
        gx++
      ) {
        for (
          let gy = Math.floor(obstacle.minY / size);
          gy <= Math.floor(obstacle.maxY / size);
          gy++
        ) {
          const key = ObstacleIndex.#key(gx, gy);
          const bucket = this.#buckets.get(key);
          if (bucket) bucket.push(obstacle);
          else this.#buckets.set(key, [obstacle]);
        }
      }
    }
  }

  static #key(gx: number, gy: number): number {
    return (gx + 32768) * 65536 + (gy + 32768);
  }

  /** The obstacles whose buckets a box from (x0, y0) to (x1, y1) touches. */
  *near(x0: number, y0: number, x1: number, y1: number): Iterable<NavmeshObstacle> {
    const size = ObstacleIndex.#SIZE;
    const seen = new Set<NavmeshObstacle>();
    for (
      let gx = Math.floor(Math.min(x0, x1) / size);
      gx <= Math.floor(Math.max(x0, x1) / size);
      gx++
    ) {
      for (
        let gy = Math.floor(Math.min(y0, y1) / size);
        gy <= Math.floor(Math.max(y0, y1) / size);
        gy++
      ) {
        for (const obstacle of this.#buckets.get(ObstacleIndex.#key(gx, gy)) ?? []) {
          if (seen.has(obstacle)) continue;
          seen.add(obstacle);
          yield obstacle;
        }
      }
    }
  }

  /** Whether a point lies under one of the obstacles. */
  covers(point: Vec3): boolean {
    for (const obstacle of this.near(point[0], point[1], point[0], point[1])) {
      if (underObstacle(obstacle, point)) return true;
    }
    return false;
  }

  /**
   * What the obstacles leave of a triangle of a navmesh (`owner`: anything that stands for the
   * navmesh, `corners`: its triangle's): freeParts, kept for this set of obstacles.
   */
  partsOf(
    owner: object,
    triangle: number,
    corners: readonly [Vec3, Vec3, Vec3],
  ): readonly (readonly Vec3[])[] | undefined {
    let known = this.#parts.get(owner);
    if (!known) {
      known = new Map();
      this.#parts.set(owner, known);
    }
    const kept = known.get(triangle);
    if (kept !== undefined) return kept ?? undefined;
    const [a, b, c] = corners;
    const low = Math.min(a[2], b[2], c[2]);
    const high = Math.max(a[2], b[2], c[2]);
    const x0 = Math.min(a[0], b[0], c[0]);
    const x1 = Math.max(a[0], b[0], c[0]);
    const y0 = Math.min(a[1], b[1], c[1]);
    const y1 = Math.max(a[1], b[1], c[1]);
    const touching: NavmeshObstacle[] = [];
    for (const obstacle of this.near(x0, y0, x1, y1)) {
      if (
        x1 >= obstacle.minX &&
        x0 <= obstacle.maxX &&
        y1 >= obstacle.minY &&
        y0 <= obstacle.maxY &&
        high >= obstacle.low &&
        low <= obstacle.high
      ) {
        touching.push(obstacle);
      }
    }
    const parts = touching.length > 0 ? freeParts(corners, touching) : undefined;
    known.set(triangle, parts ?? null);
    return parts;
  }

  /** Whether a step from `a` to `b` crosses one of the obstacles. */
  crosses(a: Vec3, b: Vec3): boolean {
    for (const obstacle of this.near(a[0], a[1], b[0], b[1])) {
      if (crossesObstacle(obstacle, a, b)) return true;
    }
    return false;
  }
}

/** Moved farther than this (units) since its cut, an obstacle's body is cut anew. */
const OBSTACLE_MOVED = 5;
/** Turned more than this (radians, 5°) since its cut, an obstacle's body is cut anew. */
const OBSTACLE_TURNED = (5 * Math.PI) / 180;

/**
 * Whether an obstacle whose body moves is cut anew where it is now (observed in the original):
 * at most every fObstacleUpdateDeltaWhenMoving seconds (`since`: since its last cut), once it
 * is more than 5 units from where it was cut or turned more than 5° (`moved`, `turned`).
 */
export function obstacleCutAnew(
  moved: number,
  turned: number,
  since: number,
  updateDelta: number,
): boolean {
  return since >= updateDelta && (moved > OBSTACLE_MOVED || turned > OBSTACLE_TURNED);
}

/** A column-major placement's axis, its scale taken out. */
function placementAxis(world: ArrayLike<number>, column: number): Vec3 {
  const x = world[column * 4] ?? 0;
  const y = world[column * 4 + 1] ?? 0;
  const z = world[column * 4 + 2] ?? 0;
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

/**
 * The cuts of obstacles whose bodies move: each stays where it was last cut until
 * obstacleCutAnew says otherwise, so one that came to rest is cut where it rests, no later than
 * the update delta after.
 */
export class MovingObstacleCuts {
  readonly #last = new Map<
    number,
    {
      readonly world: ArrayLike<number>;
      readonly cut: NavmeshObstacle | null;
      readonly at: number;
    }
  >();

  /** An obstacle's cut now: `placed` is its cut as placed, `now` where its body is. */
  cut(
    box: ObstacleBox,
    placed: NavmeshObstacle | null,
    now: ArrayLike<number>,
    clock: number,
    updateDelta: number,
  ): NavmeshObstacle | null {
    const last = this.#last.get(box.reference);
    const from = last?.world ?? box.world;
    let turned = 0;
    for (let column = 0; column < 3; column++) {
      const a = placementAxis(from, column);
      const b = placementAxis(now, column);
      const cosine = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      turned = Math.max(turned, Math.acos(Math.min(1, Math.max(-1, cosine))));
    }
    const moved = Math.hypot(
      (from[12] ?? 0) - (now[12] ?? 0),
      (from[13] ?? 0) - (now[13] ?? 0),
      (from[14] ?? 0) - (now[14] ?? 0),
    );
    if (!obstacleCutAnew(moved, turned, last ? clock - last.at : Infinity, updateDelta)) {
      return last ? last.cut : placed;
    }
    const cut = obstacleCut({ ...box, world: now }) ?? null;
    this.#last.set(box.reference, { world: Array.from(now), cut, at: clock });
    return cut;
  }
}

/** A change of the active obstacles: one came (its cut made) or went (its cut undone). */
export interface ObstacleChange {
  readonly version: number;
  readonly obstacle: NavmeshObstacle;
  readonly added: boolean;
}

/** The changes kept for movers to look back over (older ones: they search again anyway). */
const CHANGES_KEPT = 256;

/**
 * The active obstacles of the loaded area, cell by cell: each cell's set is replaced as its
 * references are enabled or disabled, open or shut (the obstacle manager's cut and undo). Each
 * change bumps the version; movers whose path an obstacle changed on search again.
 */
export class NavmeshObstacleField {
  readonly #cells = new Map<string, Map<number, NavmeshObstacle>>();
  #changes: ObstacleChange[] = [];
  #index: ObstacleIndex | undefined;
  #list: NavmeshObstacle[] | undefined;
  #version = 0;

  get version(): number {
    return this.#version;
  }

  /** A cell's active obstacles now (those not given are gone: their cut is undone). */
  setCell(key: string, active: Iterable<NavmeshObstacle>): void {
    const before = this.#cells.get(key) ?? new Map<number, NavmeshObstacle>();
    const now = new Map<number, NavmeshObstacle>();
    for (const obstacle of active) {
      const was = before.get(obstacle.reference);
      now.set(obstacle.reference, was?.outline === obstacle.outline ? was : obstacle);
    }
    for (const [reference, obstacle] of before) {
      if (now.get(reference) !== obstacle) this.#changed(obstacle, false);
    }
    for (const [reference, obstacle] of now) {
      if (before.get(reference) !== obstacle) this.#changed(obstacle, true);
    }
    if (now.size > 0) this.#cells.set(key, now);
    else this.#cells.delete(key);
  }

  /** A cell left the loaded area: its obstacles go with it (no change for movers). */
  dropCell(key: string): void {
    if (!this.#cells.delete(key)) return;
    this.#list = undefined;
    this.#index = undefined;
  }

  clear(): void {
    this.#cells.clear();
    this.#list = undefined;
    this.#index = undefined;
  }

  /** Every active obstacle. */
  get active(): readonly NavmeshObstacle[] {
    this.#list ??= [...this.#cells.values()].flatMap((cell) => [...cell.values()]);
    return this.#list;
  }

  /** The active obstacles, indexed for a path search (undefined: none). */
  get index(): ObstacleIndex | undefined {
    if (this.active.length === 0) return undefined;
    this.#index ??= new ObstacleIndex(this.active);
    return this.#index;
  }

  /** The changes after a version (undefined: too long ago to tell, take it all changed). */
  changesSince(version: number): readonly ObstacleChange[] | undefined {
    if (version >= this.#version) return [];
    const first = this.#changes[0];
    if (!first || first.version > version + 1) return undefined;
    return this.#changes.filter((change) => change.version > version);
  }

  #changed(obstacle: NavmeshObstacle, added: boolean): void {
    this.#version++;
    this.#changes.push({ version: this.#version, obstacle, added });
    if (this.#changes.length > CHANGES_KEPT) this.#changes = this.#changes.slice(-CHANGES_KEPT);
    this.#list = undefined;
    this.#index = undefined;
  }
}

/**
 * Whether changes of the obstacles touch a path's way on from `points` (a mover searches again):
 * one came across it, or one went while the path stopped short of its goal (the way may be open).
 */
export function obstaclesTouch(
  changes: readonly ObstacleChange[],
  points: readonly Vec3[],
  complete: boolean,
): boolean {
  for (const change of changes) {
    if (!change.added) {
      if (!complete) return true;
      continue;
    }
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (a && b && (crossesObstacle(change.obstacle, a, b) || underObstacle(change.obstacle, b))) {
        return true;
      }
    }
  }
  return false;
}
