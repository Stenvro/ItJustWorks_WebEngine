// Rooms, portals, occluders and multibounds placed in a cell (the engine's spatial culling
// markers). Platform-independent.
//
// Interiors are split into rooms: a RoomMarker reference whose primitive (XPRM, the same as its
// XMBO) is the room's box, placed by the reference (position, rotation, scale). Its room data
// (XRMR: linked room count, flags 0x40 has image space, 0x80 has lighting template; LNAM, INAM,
// XLRM linked rooms) belongs to it. A PortalMarker reference is a rectangle in its local XZ plane
// (XPRM half width in x, half height in z) joining the two rooms of its XPOD (origin,
// destination). A PlaneMarker is an occluder: an occlusion box (XPRM type 1) or plane, which
// hides what is behind it; a MultiBoundMarker's XMBO is the box of a group of references.
// (UESP "Mod File Format/REFR", xEdit's TES5 REFR definition.)

import { view } from '../formats/esm/fields.ts';
import type { Mat4, Vec3 } from '../render/math.ts';
import type { GameRecord } from './record-db.ts';

/** Base objects of the culling markers (Skyrim.esm's hard-coded forms). */
export const MULTIBOUND_MARKER = 0x15;
export const PLANE_MARKER = 0x17;
export const ROOM_MARKER = 0x1f;
export const PORTAL_MARKER = 0x20;

/** A box placed in the world: its centre, its unit axes and its half size along each. */
export interface OrientedBox {
  readonly center: Vec3;
  readonly axes: readonly [Vec3, Vec3, Vec3];
  readonly half: Vec3;
}

export interface CellRoom {
  readonly reference: number;
  readonly box: OrientedBox;
  /** XLRM: rooms linked to this one (seen together with it, without a portal). */
  readonly linked: readonly number[];
  /** LNAM: the room's own lighting template. TODO(M13): apply it while the camera is inside. */
  readonly lightingTemplate?: number;
  /** INAM: the room's own image space. TODO(M13): apply it while the camera is inside. */
  readonly imageSpace?: number;
}

export interface CellPortal {
  readonly reference: number;
  /** XPOD: the rooms it joins (room marker references; 0: none). */
  readonly rooms: readonly [number, number];
  /** Its rectangle's corners in order round its edge. */
  readonly corners: readonly [Vec3, Vec3, Vec3, Vec3];
}

export interface CellOccluder {
  readonly reference: number;
  readonly box: OrientedBox;
}

export interface CellMultibound {
  readonly reference: number;
  readonly box: OrientedBox;
}

export interface CellRooms {
  readonly rooms: readonly CellRoom[];
  readonly portals: readonly CellPortal[];
  readonly occluders: readonly CellOccluder[];
  readonly multibounds: readonly CellMultibound[];
}

/** An empty set of culling markers. */
export function emptyRooms(): CellRooms {
  return { rooms: [], portals: [], occluders: [], multibounds: [] };
}

/** XPRM (or XMBO) half extents, scaled. */
function halfExtents(record: GameRecord, field: 'XPRM' | 'XMBO', scale: number): Vec3 | undefined {
  const data = record.fields.first(field);
  if (!data || data.length < 12) return undefined;
  const v = view(data);
  return [
    Math.abs(v.getFloat32(0, true) * scale),
    Math.abs(v.getFloat32(4, true) * scale),
    Math.abs(v.getFloat32(8, true) * scale),
  ];
}

/** A box with half size `half` (in the reference's units, scale applied) placed by `world`. */
export function placedBox(world: Mat4, half: Vec3): OrientedBox {
  const axis = (i: number): Vec3 => {
    const x = world[i * 4] ?? 0;
    const y = world[i * 4 + 1] ?? 0;
    const z = world[i * 4 + 2] ?? 0;
    const length = Math.hypot(x, y, z) || 1;
    return [x / length, y / length, z / length];
  };
  return {
    center: [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0],
    axes: [axis(0), axis(1), axis(2)],
    half,
  };
}

/** A point in the box's own frame (along its axes, from its centre). */
export function boxLocal(box: OrientedBox, p: Vec3): Vec3 {
  const d: Vec3 = [p[0] - box.center[0], p[1] - box.center[1], p[2] - box.center[2]];
  const dot = (a: Vec3): number => a[0] * d[0] + a[1] * d[1] + a[2] * d[2];
  return [dot(box.axes[0]), dot(box.axes[1]), dot(box.axes[2])];
}

/** Whether the box holds a point (`margin` widens it on every side). */
export function boxContains(box: OrientedBox, p: Vec3, margin = 0): boolean {
  const local = boxLocal(box, p);
  return (
    Math.abs(local[0]) <= box.half[0] + margin &&
    Math.abs(local[1]) <= box.half[1] + margin &&
    Math.abs(local[2]) <= box.half[2] + margin
  );
}

export function boxVolume(box: OrientedBox): number {
  return box.half[0] * box.half[1] * box.half[2];
}

/** The box's eight corners. */
export function boxCorners(box: OrientedBox): Vec3[] {
  const corners: Vec3[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const a = box.axes;
        const h = box.half;
        corners.push([
          box.center[0] + a[0][0] * h[0] * sx + a[1][0] * h[1] * sy + a[2][0] * h[2] * sz,
          box.center[1] + a[0][1] * h[0] * sx + a[1][1] * h[1] * sy + a[2][1] * h[2] * sz,
          box.center[2] + a[0][2] * h[0] * sx + a[1][2] * h[1] * sy + a[2][2] * h[2] * sz,
        ]);
      }
    }
  }
  return corners;
}

/**
 * Reads a culling marker into `into` when the reference's base is one (`world`: its placement,
 * `scale` its scale). Returns whether it was one.
 */
export function addCullingMarker(
  into: {
    rooms: CellRoom[];
    portals: CellPortal[];
    occluders: CellOccluder[];
    multibounds: CellMultibound[];
  },
  record: GameRecord,
  base: number,
  world: Mat4,
  scale: number,
): boolean {
  if (base === ROOM_MARKER) {
    const half = halfExtents(record, 'XPRM', scale) ?? halfExtents(record, 'XMBO', scale);
    if (!half) return true;
    const xrmr = record.fields.first('XRMR');
    const flags = xrmr?.[1] ?? 0;
    const lightingTemplate = (flags & 0x80) !== 0 ? record.formIdField('LNAM') : undefined;
    const imageSpace = (flags & 0x40) !== 0 ? record.formIdField('INAM') : undefined;
    into.rooms.push({
      reference: record.formId,
      box: placedBox(world, half),
      linked: record.fields
        .all('XLRM')
        .filter((data) => data.length >= 4)
        .map((data) => record.formIdAt(data))
        .filter((id) => id !== 0),
      ...(lightingTemplate ? { lightingTemplate } : {}),
      ...(imageSpace ? { imageSpace } : {}),
    });
    return true;
  }
  if (base === PORTAL_MARKER) {
    const half = halfExtents(record, 'XPRM', scale);
    const xpod = record.fields.first('XPOD');
    if (!half || !xpod || xpod.length < 8) return true;
    const box = placedBox(world, half);
    const [ax, , az] = box.axes;
    const corner = (sx: number, sz: number): Vec3 => [
      box.center[0] + ax[0] * half[0] * sx + az[0] * half[2] * sz,
      box.center[1] + ax[1] * half[0] * sx + az[1] * half[2] * sz,
      box.center[2] + ax[2] * half[0] * sx + az[2] * half[2] * sz,
    ];
    into.portals.push({
      reference: record.formId,
      rooms: [record.formIdAt(xpod, 0), record.formIdAt(xpod, 4)],
      corners: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
    });
    return true;
  }
  if (base === PLANE_MARKER) {
    const half = halfExtents(record, 'XPRM', scale);
    if (half) into.occluders.push({ reference: record.formId, box: placedBox(world, half) });
    return true;
  }
  if (base === MULTIBOUND_MARKER) {
    const half = halfExtents(record, 'XMBO', scale) ?? halfExtents(record, 'XPRM', scale);
    if (half) into.multibounds.push({ reference: record.formId, box: placedBox(world, half) });
    return true;
  }
  return false;
}

/**
 * The room a point belongs to: the smallest room box holding it (rooms may overlap at their
 * doorways), as its index in `rooms`; −1 outside every room.
 */
export function roomIndexAt(rooms: readonly Pick<CellRoom, 'box'>[], p: Vec3): number {
  let best = -1;
  let bestVolume = Infinity;
  rooms.forEach((room, i) => {
    if (!boxContains(room.box, p)) return;
    const volume = boxVolume(room.box);
    if (volume < bestVolume) {
      best = i;
      bestVolume = volume;
    }
  });
  return best;
}
