import { describe, expect, it } from 'vitest';
import { FormatError } from '../formats/binary-reader.ts';
import { Fields } from '../formats/esm/fields.ts';
import type { Field } from '../formats/esm/record.ts';
import { PathingType } from './navmesh.ts';
import {
  mergeNavmeshInfo,
  NavmeshInfoFlag,
  parseNavmeshInfoRecord,
  precomputedPath,
  type NavmeshInfoRecord,
} from './navmesh-info.ts';
import { GameRecord, type Plugin, type RecordDatabase } from './record-db.ts';

/** Form ids are stored as they are (one plugin). */
const db = { toGlobal: (_plugin: Plugin, local: number) => local } as unknown as RecordDatabase;

type Value = readonly ['u8' | 'u16' | 'i16' | 'u32' | 'f32', number];

const SIZE = { u8: 1, u16: 2, i16: 2, u32: 4, f32: 4 } as const;

/** Little-endian bytes from a list of [type, value] pairs. */
function bytes(values: readonly Value[]): Uint8Array {
  const data = new Uint8Array(values.reduce((sum, [type]) => sum + SIZE[type], 0));
  const view = new DataView(data.buffer);
  let offset = 0;
  for (const [type, value] of values) {
    if (type === 'u8') view.setUint8(offset, value);
    else if (type === 'u16') view.setUint16(offset, value, true);
    else if (type === 'i16') view.setInt16(offset, value, true);
    else if (type === 'u32') view.setUint32(offset, value, true);
    else view.setFloat32(offset, value, true);
    offset += SIZE[type];
  }
  return data;
}

const u32 = (value: number): Value => ['u32', value];
const f32 = (value: number): Value => ['f32', value];

/** An interior navmesh with a door, and island data: one triangle. */
const interior = bytes([
  u32(0x7000),
  u32(NavmeshInfoFlag.island),
  ...[10, 20, 30].map(f32),
  f32(0.25),
  u32(0), // no edge links
  u32(0), // no preferred edge links
  u32(1),
  u32(PathingType.door),
  u32(0x6000),
  ['u8', 1],
  ...[0, 0, 0, 100, 100, 0].map(f32),
  u32(1),
  ['u16', 0],
  ['u16', 1],
  ['u16', 2],
  u32(3),
  ...[0, 0, 0, 100, 0, 0, 100, 100, 0].map(f32),
  u32(PathingType.cell),
  u32(0), // no worldspace
  u32(0x5000), // the cell
]);

/** A worldspace navmesh between two others, one over preferred triangles; no island data. */
function exterior(navmesh: number, extra: readonly Value[] = []): Uint8Array {
  return bytes([
    u32(navmesh),
    u32(0),
    ...[4096, -2048, 0].map(f32),
    f32(0),
    u32(1),
    u32(0x7002),
    u32(1),
    u32(0x7003),
    u32(0), // no doors
    ['u8', 0],
    u32(PathingType.cell),
    u32(0x3c),
    ['i16', -1], // grid y
    ['i16', 1], // grid x
    ...extra,
  ]);
}

/** Two road markers and their 2 × 2 path matrix. */
const nvpp = bytes([
  u32(4),
  u32(1),
  u32(0x7001),
  u32(3),
  u32(0x7001),
  u32(0x7002),
  u32(0x7003),
  u32(3),
  u32(0x7003),
  u32(0x7002),
  u32(0x7001),
  u32(1),
  u32(0x7003),
  u32(2), // markers
  u32(0x7003),
  u32(1),
  u32(0x7001),
  u32(0),
]);

const navi = (fields: readonly Field[]): GameRecord =>
  new GameRecord(db, {} as Plugin, 'NAVI', 0x12fb4, 0, new Fields(fields));

const nver = (version = 12): Field => ({ type: 'NVER', data: bytes([u32(version)]) });

describe('navmesh info map', () => {
  it('reads its entries, precomputed paths and deleted navmeshes', () => {
    const record = parseNavmeshInfoRecord(
      navi([
        nver(),
        { type: 'NVMI', data: interior },
        { type: 'NVMI', data: exterior(0x7001) },
        { type: 'NVPP', data: nvpp },
        { type: 'NVSI', data: bytes([u32(0x7009)]) },
      ]),
    );
    expect(record.version).toBe(12);
    const [inside, outside] = record.infos;
    expect(inside).toMatchObject({
      navmesh: 0x7000,
      flags: NavmeshInfoFlag.island,
      location: [10, 20, 30],
      preferred: 0.25,
      edgeLinks: [],
      preferredEdgeLinks: [],
      doors: [0x6000],
      world: 0,
      cell: 0x5000,
    });
    expect(inside?.island?.max).toEqual([100, 100, 0]);
    expect([...(inside?.island?.triangles ?? [])]).toEqual([0, 1, 2]);
    expect(inside?.island?.vertices).toHaveLength(9);
    expect(outside).toMatchObject({
      navmesh: 0x7001,
      edgeLinks: [0x7002],
      preferredEdgeLinks: [0x7003],
      doors: [],
      island: undefined,
      world: 0x3c,
      cell: { x: 1, y: -1 },
    });
    expect(record.paths).toEqual([
      [0x7001],
      [0x7001, 0x7002, 0x7003],
      [0x7003, 0x7002, 0x7001],
      [0x7003],
    ]);
    expect(record.roadMarkers).toEqual([
      { navmesh: 0x7003, index: 1 },
      { navmesh: 0x7001, index: 0 },
    ]);
    expect(record.deleted).toEqual([0x7009]);
  });

  it('rejects other versions, unknown types and data left over', () => {
    const parse = (fields: Field[]): NavmeshInfoRecord => parseNavmeshInfoRecord(navi(fields));
    expect(() => parse([nver(11)])).toThrow(FormatError);
    expect(() => parse([nver(), { type: 'NVMI', data: exterior(0x7001, [u32(0)]) }])).toThrow(
      FormatError,
    );
    const wrongDoor = interior.slice();
    new DataView(wrongDoor.buffer).setUint32(36, PathingType.cell, true);
    expect(() => parse([nver(), { type: 'NVMI', data: wrongDoor }])).toThrow(FormatError);
    expect(() => parse([nver(), { type: 'NVSI', data: new Uint8Array(3) }])).toThrow(FormatError);
  });

  it('merges the plugins: later entries win, deleted navmeshes go', () => {
    const base = parseNavmeshInfoRecord(
      navi([
        nver(),
        { type: 'NVMI', data: interior },
        { type: 'NVMI', data: exterior(0x7001) },
        { type: 'NVPP', data: nvpp },
      ]),
    );
    const update = parseNavmeshInfoRecord(
      navi([
        nver(),
        { type: 'NVMI', data: exterior(0x7000) },
        { type: 'NVSI', data: bytes([u32(0x7001)]) },
      ]),
    );
    const map = mergeNavmeshInfo([base, update]);
    expect([...map.infos.keys()]).toEqual([0x7000]);
    expect(map.infos.get(0x7000)?.world).toBe(0x3c);
    expect(map.paths).toHaveLength(4);
    expect(precomputedPath(map, 0x7001, 0x7003)).toEqual([0x7001, 0x7002, 0x7003]);
    expect(precomputedPath(map, 0x7003, 0x7001)).toEqual([0x7003, 0x7002, 0x7001]);
    expect(precomputedPath(map, 0x7003, 0x7003)).toEqual([0x7003]);
    expect(precomputedPath(map, 0x7002, 0x7003)).toBeUndefined();
  });
});
