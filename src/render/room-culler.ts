// Room and portal visibility, and occlusion culling (the engine's culling markers: cell-rooms.ts).
// Each frame the culler finds the rooms the camera stands in and walks the portal graph from
// them: a room behind a portal is seen only through the portal's screen rectangle, narrowed by
// every portal on the way. A draw is visible when one of the rooms holding its centre is seen
// through one of its rectangles, or when no room holds it; with the camera outside every room
// (or no rooms at all) everything is drawn. Occluders (occlusion boxes and planes) hide what lies
// wholly behind a face of theirs turned to the camera. Platform-independent.

import { boxContains, roomIndexAt, type CellRooms, type OrientedBox } from '../world/cell-rooms.ts';
import { frustumPlanes, sphereVisible, type Plane } from './frustum.ts';
import type { Mat4, Vec3 } from './math.ts';

/** A rectangle on the screen in normalized device coordinates. */
export interface ScreenRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

const FULL_SCREEN: ScreenRect = { x0: -1, y0: -1, x1: 1, y1: 1 };
/** How many portals deep the walk goes. */
const MAX_DEPTH = 32;
/** Rectangles kept per room before they are merged into one. */
const MAX_RECTS = 8;
/** Clip-space w below which a portal corner counts as behind the camera. */
const NEAR_W = 1;
/** A camera this close to a portal's plane, within its edges, sees through all of it. */
const IN_DOORWAY = 32;

interface Portal {
  readonly rooms: readonly [number, number];
  readonly corners: readonly Vec3[];
  readonly normal: Vec3;
  readonly center: Vec3;
  readonly halfWidth: number;
  readonly halfHeight: number;
  readonly across: Vec3;
  readonly up: Vec3;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: Vec3): Vec3 => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};

function contains(outer: ScreenRect, inner: ScreenRect): boolean {
  return (
    inner.x0 >= outer.x0 && inner.y0 >= outer.y0 && inner.x1 <= outer.x1 && inner.y1 <= outer.y1
  );
}

function intersect(a: ScreenRect, b: ScreenRect): ScreenRect | undefined {
  const rect = {
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
  };
  return rect.x0 < rect.x1 && rect.y0 < rect.y1 ? rect : undefined;
}

/**
 * The screen rectangle a polygon covers, clipped against the camera's near side (undefined:
 * wholly behind the camera).
 */
export function polygonRect(viewProj: Mat4, corners: readonly Vec3[]): ScreenRect | undefined {
  const clip = corners.map((p) => {
    const c = (row: number): number =>
      (viewProj[row] ?? 0) * p[0] +
      (viewProj[4 + row] ?? 0) * p[1] +
      (viewProj[8 + row] ?? 0) * p[2] +
      (viewProj[12 + row] ?? 0);
    return [c(0), c(1), c(3)] as const;
  });
  // Sutherland–Hodgman against w ≥ NEAR_W.
  const kept: (readonly [number, number, number])[] = [];
  for (let i = 0; i < clip.length; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    if (!a || !b) continue;
    const aIn = a[2] >= NEAR_W;
    const bIn = b[2] >= NEAR_W;
    if (aIn) kept.push(a);
    if (aIn !== bIn) {
      const t = (NEAR_W - a[2]) / (b[2] - a[2]);
      kept.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR_W]);
    }
  }
  if (kept.length === 0) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y, w] of kept) {
    x0 = Math.min(x0, x / w);
    x1 = Math.max(x1, x / w);
    y0 = Math.min(y0, y / w);
    y1 = Math.max(y1, y / w);
  }
  return { x0, y0, x1, y1 };
}

/** The planes bounding what a screen rectangle shows (its four sides and the near plane). */
export function rectPlanes(viewProj: Mat4, rect: ScreenRect): Plane[] {
  const row = (r: number): number[] => [
    viewProj[r] ?? 0,
    viewProj[4 + r] ?? 0,
    viewProj[8 + r] ?? 0,
    viewProj[12 + r] ?? 0,
  ];
  const [r0, r1, r2, r3] = [row(0), row(1), row(2), row(3)];
  const plane = (a: number[], sa: number, b: number[], sb: number): Plane => {
    const p = [0, 1, 2, 3].map((i) => sa * (a[i] ?? 0) + sb * (b[i] ?? 0));
    const length = Math.hypot(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0) || 1;
    return [(p[0] ?? 0) / length, (p[1] ?? 0) / length, (p[2] ?? 0) / length, (p[3] ?? 0) / length];
  };
  return [
    plane(r0, 1, r3, -rect.x0), // x ≥ x0·w
    plane(r3, rect.x1, r0, -1), // x ≤ x1·w
    plane(r1, 1, r3, -rect.y0),
    plane(r3, rect.y1, r1, -1),
    plane(r3, 1, r2, -1), // near (reversed Z: z ≤ w)
  ];
}

/**
 * The volumes an occluder hides from `camera`: for each face turned to the camera, the planes
 * through the camera and the face's edges and the face's own plane (a point hidden is on the
 * inner side of all of them).
 */
export function occlusionVolumes(box: OrientedBox, camera: Vec3): Plane[][] {
  const volumes: Plane[][] = [];
  for (let k = 0; k < 3; k++) {
    const u = (k + 1) % 3;
    const v = (k + 2) % 3;
    const hu = box.half[u] ?? 0;
    const hv = box.half[v] ?? 0;
    // A face of no size hides nothing (a plane's edges).
    if (hu * hv < 1) continue;
    for (const sign of [-1, 1]) {
      const axis = box.axes[k] ?? [1, 0, 0];
      const n: Vec3 = [axis[0] * sign, axis[1] * sign, axis[2] * sign];
      const h = box.half[k] ?? 0;
      const fc: Vec3 = [
        box.center[0] + n[0] * h,
        box.center[1] + n[1] * h,
        box.center[2] + n[2] * h,
      ];
      if (dot(n, sub(camera, fc)) <= 0) continue;
      const au = box.axes[u] ?? [1, 0, 0];
      const av = box.axes[v] ?? [0, 1, 0];
      const corner = (su: number, sv: number): Vec3 => [
        fc[0] + au[0] * hu * su + av[0] * hv * sv,
        fc[1] + au[1] * hu * su + av[1] * hv * sv,
        fc[2] + au[2] * hu * su + av[2] * hv * sv,
      ];
      const corners = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
      const planes: Plane[] = [[-n[0], -n[1], -n[2], dot(n, fc)]];
      for (let i = 0; i < 4; i++) {
        const a = corners[i] ?? fc;
        const b = corners[(i + 1) % 4] ?? fc;
        let m = normalize(cross(sub(a, camera), sub(b, camera)));
        if (dot(m, sub(fc, camera)) < 0) m = [-m[0], -m[1], -m[2]];
        planes.push([m[0], m[1], m[2], -dot(m, camera)]);
      }
      volumes.push(planes);
    }
  }
  return volumes;
}

/** Whether a sphere lies wholly on the inner side of every plane. */
function sphereInside(planes: readonly Plane[], center: Vec3, radius: number): boolean {
  for (const [nx, ny, nz, d] of planes) {
    if (nx * center[0] + ny * center[1] + nz * center[2] + d < radius) return false;
  }
  return true;
}

export class RoomCuller {
  readonly #sets: readonly CellRooms[];
  readonly #boxes: OrientedBox[] = [];
  readonly #portals: Portal[] = [];
  /** Per room: its portals' indices, and the rooms linked to it (XLRM, both ways). */
  readonly #portalsOf: number[][] = [];
  readonly #linkedOf: number[][] = [];
  /** Per room this frame: the planes of each rectangle it is seen through. */
  #seen: Plane[][][] = [];
  #rects: ScreenRect[][] = [];
  #occluders: Plane[][] = [];
  #active = false;
  /** The rooms holding a draw's centre (cached by the centre's array: static draws keep it). */
  #membership = new WeakMap<Vec3, readonly number[]>();
  /** Counted in `visible` since the last update (for the frame's statistics). */
  tested = 0;
  culled = 0;

  constructor(sets: readonly CellRooms[]) {
    this.#sets = sets;
    const roomIndex = new Map<number, number>();
    for (const set of sets) {
      for (const room of set.rooms) {
        roomIndex.set(room.reference, this.#boxes.length);
        this.#boxes.push(room.box);
        this.#portalsOf.push([]);
        this.#linkedOf.push([]);
      }
    }
    for (const set of sets) {
      for (const room of set.rooms) {
        const a = roomIndex.get(room.reference) ?? -1;
        for (const linked of room.linked) {
          const b = roomIndex.get(linked);
          if (a < 0 || b === undefined || a === b) continue;
          this.#linkedOf[a]?.push(b);
          this.#linkedOf[b]?.push(a);
        }
      }
      for (const portal of set.portals) {
        const a = roomIndex.get(portal.rooms[0]) ?? -1;
        const b = roomIndex.get(portal.rooms[1]) ?? -1;
        if (a < 0 && b < 0) continue;
        const [c0, c1, , c3] = portal.corners;
        const across = sub(c1, c0);
        const up = sub(c3, c0);
        const mid = (k: 0 | 1 | 2): number =>
          portal.corners.reduce((sum, c) => sum + c[k], 0) / portal.corners.length;
        const center: Vec3 = [mid(0), mid(1), mid(2)];
        const index = this.#portals.length;
        this.#portals.push({
          rooms: [a, b],
          corners: portal.corners,
          normal: normalize(cross(across, up)),
          center,
          halfWidth: Math.hypot(...across) / 2,
          halfHeight: Math.hypot(...up) / 2,
          across: normalize(across),
          up: normalize(up),
        });
        if (a >= 0) this.#portalsOf[a]?.push(index);
        if (b >= 0 && b !== a) this.#portalsOf[b]?.push(index);
      }
    }
  }

  /** Draws tested and hidden since the last update. */
  get counts(): { readonly tested: number; readonly culled: number } {
    return { tested: this.tested, culled: this.culled };
  }

  /** Whether the cells have any rooms. */
  get hasRooms(): boolean {
    return this.#boxes.length > 0;
  }

  /** Whether rooms cull this frame (the camera stands in one). */
  get active(): boolean {
    return this.#active;
  }

  /** The rooms seen this frame (their indices over the cells' rooms in order). */
  get visibleRooms(): number[] {
    return this.#seen.flatMap((planes, i) => (planes.length > 0 ? [i] : []));
  }

  /** The rectangles a room is seen through this frame. */
  rectsOf(room: number): readonly ScreenRect[] {
    return this.#rects[room] ?? [];
  }

  /** The room (index) a point is in: the smallest holding it; −1 none. */
  roomAt(p: Vec3): number {
    return roomIndexAt(
      this.#boxes.map((box) => ({ box })),
      p,
    );
  }

  /** Walks the portals from the camera's rooms and gathers the occluders turned to it. */
  update(viewProj: Mat4, camera: Vec3): void {
    this.tested = 0;
    this.culled = 0;
    this.#seen = this.#boxes.map(() => []);
    this.#rects = this.#boxes.map(() => []);
    const frustum = frustumPlanes(viewProj);
    this.#occluders = [];
    for (const set of this.#sets) {
      for (const occluder of set.occluders) {
        const box = occluder.box;
        if (boxContains(box, camera, 1)) continue;
        const radius = Math.hypot(...box.half);
        if (!sphereVisible(frustum, box.center, radius)) continue;
        this.#occluders.push(...occlusionVolumes(box, camera));
      }
    }

    const starts: number[] = [];
    this.#boxes.forEach((box, i) => {
      if (boxContains(box, camera)) starts.push(i);
    });
    this.#active = starts.length > 0;
    if (!this.#active) return;
    const stack: { room: number; rect: ScreenRect; depth: number }[] = starts.map((room) => ({
      room,
      rect: FULL_SCREEN,
      depth: 0,
    }));
    const portalRects = new Map<number, ScreenRect | undefined>();
    const portalRect = (index: number): ScreenRect | undefined => {
      if (portalRects.has(index)) return portalRects.get(index);
      const portal = this.#portals[index];
      let rect: ScreenRect | undefined;
      if (portal) {
        const offset = sub(camera, portal.center);
        const inDoorway =
          Math.abs(dot(offset, portal.normal)) < IN_DOORWAY &&
          Math.abs(dot(offset, portal.across)) <= portal.halfWidth &&
          Math.abs(dot(offset, portal.up)) <= portal.halfHeight;
        rect = inDoorway ? FULL_SCREEN : polygonRect(viewProj, portal.corners);
      }
      portalRects.set(index, rect);
      return rect;
    };
    while (stack.length > 0) {
      const entry = stack.pop();
      if (!entry) break;
      const { room, rect, depth } = entry;
      const rects = this.#rects[room];
      if (!rects || rects.some((seen) => contains(seen, rect))) continue;
      if (rects.length >= MAX_RECTS) {
        // Too many: one rectangle round them all.
        const merged = rects.reduce(
          (all, r) => ({
            x0: Math.min(all.x0, r.x0),
            y0: Math.min(all.y0, r.y0),
            x1: Math.max(all.x1, r.x1),
            y1: Math.max(all.y1, r.y1),
          }),
          rect,
        );
        rects.length = 0;
        rects.push(merged);
      } else {
        rects.push(rect);
      }
      if (depth >= MAX_DEPTH) continue;
      for (const linked of this.#linkedOf[room] ?? []) {
        stack.push({ room: linked, rect, depth: depth + 1 });
      }
      for (const index of this.#portalsOf[room] ?? []) {
        const portal = this.#portals[index];
        if (!portal) continue;
        const other = portal.rooms[0] === room ? portal.rooms[1] : portal.rooms[0];
        if (other < 0) continue;
        const through = portalRect(index);
        const narrowed = through && intersect(rect, through);
        if (narrowed) stack.push({ room: other, rect: narrowed, depth: depth + 1 });
      }
    }
    this.#seen = this.#rects.map((rects) => rects.map((rect) => rectPlanes(viewProj, rect)));
  }

  /**
   * Whether a point stands in a room seen this frame (or in no room, or rooms do not cull):
   * shadow lights and their casters outside the rooms seen are left out, wherever on the
   * screen their shadows would fall.
   */
  inVisibleRoom(point: Vec3): boolean {
    if (!this.#active) return true;
    let rooms = this.#membership.get(point);
    if (!rooms) {
      rooms = this.#boxes.flatMap((box, i) => (boxContains(box, point) ? [i] : []));
      this.#membership.set(point, rooms);
    }
    if (rooms.length === 0) return true;
    return rooms.some((room) => (this.#seen[room]?.length ?? 0) > 0);
  }

  /** Whether a draw's bounding sphere may be seen this frame (rooms and occluders). */
  visible(center: Vec3, radius: number): boolean {
    this.tested++;
    for (const volume of this.#occluders) {
      if (sphereInside(volume, center, radius)) {
        this.culled++;
        return false;
      }
    }
    if (!this.#active) return true;
    let rooms = this.#membership.get(center);
    if (!rooms) {
      rooms = this.#boxes.flatMap((box, i) => (boxContains(box, center) ? [i] : []));
      this.#membership.set(center, rooms);
    }
    if (rooms.length === 0) return true;
    for (const room of rooms) {
      for (const planes of this.#seen[room] ?? []) {
        if (sphereVisible(planes, center, radius)) return true;
      }
    }
    this.culled++;
    return false;
  }
}
