import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { referenceMatrix } from './cell-loader.ts';
import {
  addCullingMarker,
  boxContains,
  emptyRooms,
  PLANE_MARKER,
  PORTAL_MARKER,
  ROOM_MARKER,
  roomIndexAt,
  type CellRooms,
} from './cell-rooms.ts';
import { GameRecord, type Plugin, type RecordDatabase } from './record-db.ts';

const db = { toGlobal: (_plugin: Plugin, local: number) => local } as unknown as RecordDatabase;
const plugin = {} as Plugin;

const floats = (...values: number[]): Uint8Array => new Uint8Array(new Float32Array(values).buffer);
const ids = (...values: number[]): Uint8Array => new Uint8Array(new Uint32Array(values).buffer);

function marker(formId: number, fields: [string, Uint8Array][]): GameRecord {
  return new GameRecord(
    db,
    plugin,
    'REFR',
    formId,
    0,
    new Fields(fields.map(([type, data]) => ({ type, data }))),
  );
}

function mutable(): CellRooms & {
  rooms: CellRooms['rooms'][number][];
  portals: CellRooms['portals'][number][];
  occluders: CellRooms['occluders'][number][];
  multibounds: CellRooms['multibounds'][number][];
} {
  return { rooms: [], portals: [], occluders: [], multibounds: [] };
}

describe('culling markers', () => {
  it('reads a room box, its linked rooms and its lighting template', () => {
    const into = mutable();
    const room = marker(0x100, [
      ['XPRM', floats(128, 64, 32, 0, 0.5, 1, 0.2, 0)],
      ['XRMR', new Uint8Array([1, 0x80, 0, 0])],
      ['LNAM', ids(0x555)],
      ['XLRM', ids(0x101)],
    ]);
    const world = referenceMatrix({
      position: [1000, 0, 0],
      rotation: [0, 0, Math.PI / 2],
      scale: 2,
    });
    expect(addCullingMarker(into, room, ROOM_MARKER, world, 2)).toBe(true);
    const [read] = into.rooms;
    expect(read?.linked).toEqual([0x101]);
    expect(read?.lightingTemplate).toBe(0x555);
    expect(read?.box.half).toEqual([256, 128, 64]);
    // Turned a quarter: its long local x runs along world y.
    expect(read && boxContains(read.box, [1000, 250, 0])).toBe(true);
    expect(read && boxContains(read.box, [1250, 0, 0])).toBe(false);
  });

  it('reads a portal as a rectangle in its local XZ plane joining the XPOD rooms', () => {
    const into = mutable();
    const portal = marker(0x200, [
      ['XPRM', floats(100, 1, 50, 0, 0, 0, 0.25, 0)],
      ['XPOD', ids(0x100, 0x101)],
    ]);
    const world = referenceMatrix({ position: [0, 100, 0], rotation: [0, 0, 0], scale: 1 });
    addCullingMarker(into, portal, PORTAL_MARKER, world, 1);
    expect(into.portals[0]?.rooms).toEqual([0x100, 0x101]);
    for (const corner of into.portals[0]?.corners ?? []) {
      expect(Math.abs(corner[0])).toBeCloseTo(100);
      expect(corner[1]).toBeCloseTo(100);
      expect(Math.abs(corner[2])).toBeCloseTo(50);
    }
  });

  it('reads a plane marker as an occluder and ignores other bases', () => {
    const into = mutable();
    const plane = marker(0x300, [['XPRM', floats(96, 896, 640, 1, 1, 1, 0.15, 0)]]);
    const world = referenceMatrix({ position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 });
    expect(addCullingMarker(into, plane, PLANE_MARKER, world, 1)).toBe(true);
    expect(into.occluders).toHaveLength(1);
    expect(addCullingMarker(into, plane, 0x3b, world, 1)).toBe(false);
    expect(emptyRooms().rooms).toEqual([]);
  });

  it('puts a point in the smallest room holding it', () => {
    const box = (center: [number, number, number], half: [number, number, number]) => ({
      center,
      axes: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ] as const,
      half,
    });
    const rooms = [{ box: box([0, 0, 0], [500, 500, 500]) }, { box: box([0, 0, 0], [50, 50, 50]) }];
    expect(roomIndexAt(rooms, [10, 10, 10])).toBe(1);
    expect(roomIndexAt(rooms, [100, 10, 10])).toBe(0);
    expect(roomIndexAt(rooms, [1000, 10, 10])).toBe(-1);
  });
});
