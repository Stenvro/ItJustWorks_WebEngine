import { describe, expect, it } from 'vitest';
import { FormatError } from '../formats/binary-reader.ts';
import { Fields } from '../formats/esm/fields.ts';
import { navmeshTriangle, NavmeshFlag, NavmeshSurface, parseNavmesh } from './navmesh.ts';
import { GameRecord, type Plugin, type RecordDatabase } from './record-db.ts';

/** Form ids are stored as they are (one plugin). */
const db = { toGlobal: (_plugin: Plugin, local: number) => local } as unknown as RecordDatabase;

/** Little-endian bytes from a list of [type, value] pairs. */
function bytes(values: readonly (readonly ['u16' | 'i16' | 'u32' | 'f32', number])[]): Uint8Array {
  const size = values.reduce((sum, [type]) => sum + (type === 'u16' || type === 'i16' ? 2 : 4), 0);
  const data = new Uint8Array(size);
  const view = new DataView(data.buffer);
  let offset = 0;
  for (const [type, value] of values) {
    if (type === 'u16') view.setUint16(offset, value, true);
    else if (type === 'i16') view.setInt16(offset, value, true);
    else if (type === 'u32') view.setUint32(offset, value, true);
    else view.setFloat32(offset, value, true);
    offset += type === 'u16' || type === 'i16' ? 2 : 4;
  }
  return data;
}

/** An interior navigation mesh: two triangles of a ramp, a door on the first. */
function nvnm(version = 12, extra: readonly (readonly ['u32', number])[] = []): Uint8Array {
  return bytes([
    ['u32', version],
    ['u32', 0x1234],
    ['u32', 0], // no worldspace: an interior
    ['u32', 0x5000], // its cell
    ['u32', 4],
    ...[0, 0, 0, 100, 0, 0, 100, 100, 50, 0, 100, 50].map((v) => ['f32', v] as const),
    ['u32', 2],
    ['u16', 0],
    ['u16', 1],
    ['u16', 2],
    ['i16', -1],
    ['i16', 1],
    ['i16', -1],
    ['u16', NavmeshFlag.edge12Link | NavmeshFlag.door],
    ['u16', 0],
    ['u16', 0],
    ['u16', 2],
    ['u16', 3],
    ['i16', -1],
    ['i16', -1],
    ['i16', 0],
    ['u16', NavmeshFlag.edge20Link],
    ['u16', 0x0408],
    ['u32', 0], // no links into other meshes
    ['u32', 1], // one door triangle
    ['u16', 0],
    ['u32', 0x2f],
    ['u32', 0x6000],
    ['u32', 1], // one cover triangle
    ['u16', 1],
    ['u32', 1], // a 1×1 search grid
    ['f32', 100],
    ['f32', 100],
    ...[0, 0, 0, 100, 100, 50].map((v) => ['f32', v] as const),
    ['u32', 2],
    ['u16', 0],
    ['u16', 1],
    ...extra,
  ]);
}

const record = (data: Uint8Array): GameRecord =>
  new GameRecord(db, {} as Plugin, 'NAVM', 0x7000, 0, new Fields([{ type: 'NVNM', data }]));

describe('navigation meshes', () => {
  it('reads vertices, triangles with their neighbours, doors, cover and the search grid', () => {
    const navmesh = parseNavmesh(record(nvnm()));
    expect(navmesh?.world).toBe(0);
    expect(navmesh?.cell).toBe(0x5000);
    expect(navmesh?.vertices).toHaveLength(12);
    expect(navmesh?.triangles).toEqual([
      { vertices: [0, 1, 2], edges: [-1, 1, -1], flags: 0x0402, cover: 0 },
      { vertices: [0, 2, 3], edges: [-1, -1, 0], flags: 0x0004, cover: 0x0408 },
    ]);
    expect(navmesh?.doors).toEqual([{ triangle: 0, type: 0x2f, door: 0x6000 }]);
    expect(navmesh?.coverTriangles).toEqual([1]);
    expect(navmesh?.grid.cells).toEqual([[0, 1]]);
    expect(navmesh && navmeshTriangle(navmesh, 1)).toEqual([
      [0, 0, 0],
      [100, 100, 50],
      [0, 100, 50],
    ]);
  });

  it('rejects other versions and data left over', () => {
    expect(() => parseNavmesh(record(nvnm(13)))).toThrow(FormatError);
    expect(() => parseNavmesh(record(nvnm(12, [['u32', 7]])))).toThrow(FormatError);
  });

  it('has nothing without its NVNM field', () => {
    expect(
      parseNavmesh(new GameRecord(db, {} as Plugin, 'NAVM', 0x7000, 0, new Fields([]))),
    ).toBeUndefined();
  });

  it('tells the height of its surface over a point, near a height', () => {
    const navmesh = parseNavmesh(record(nvnm()));
    const surface = new NavmeshSurface(navmesh ? [navmesh] : []);
    // The ramp rises 50 from y 0 to y 100.
    expect(surface.heightNear(50, 50, 30, 24)).toBeCloseTo(25, 3);
    expect(surface.heightNear(80, 10, 0, 24)).toBeCloseTo(5, 3);
    expect(surface.heightNear(50, 50, 100, 24)).toBeUndefined();
    expect(surface.heightNear(150, 50, 25, 24)).toBeUndefined();
  });
});
