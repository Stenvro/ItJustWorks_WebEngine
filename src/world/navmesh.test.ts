import { describe, expect, it } from 'vitest';
import { FormatError } from '../formats/binary-reader.ts';
import { Fields } from '../formats/esm/fields.ts';
import {
  navmeshTriangle,
  NavmeshFlag,
  NavmeshLinkType,
  NavmeshSurface,
  parseNavmesh,
  PathingType,
  triangleNeighbour,
} from './navmesh.ts';
import { GameRecord, type Plugin, type RecordDatabase } from './record-db.ts';

/** Form ids are stored as they are (one plugin). */
const db = { toGlobal: (_plugin: Plugin, local: number) => local } as unknown as RecordDatabase;

type Value = readonly ['u16' | 'i16' | 'u32' | 'f32', number];

/** Little-endian bytes from a list of [type, value] pairs. */
function bytes(values: readonly Value[]): Uint8Array {
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

/** An interior: no worldspace, then its cell. */
const INTERIOR: readonly Value[] = [
  ['u32', 0],
  ['u32', 0x5000],
];

/**
 * A navigation mesh: two triangles of a ramp sharing their edge 0–2. The first's edge 0–1 leads
 * into another mesh (link 0) and it has a door; the second's edge 1–2 is a ledge down onto the
 * first (link 1).
 */
function nvnm(
  options: {
    version?: number;
    cellType?: number;
    place?: readonly Value[];
    extra?: readonly Value[];
  } = {},
): Uint8Array {
  return bytes([
    ['u32', options.version ?? 12],
    ['u32', options.cellType ?? PathingType.cell],
    ...(options.place ?? INTERIOR),
    ['u32', 4],
    ...[0, 0, 0, 100, 0, 0, 100, 100, 50, 0, 100, 50].map((v) => ['f32', v] as const),
    ['u32', 2],
    ['u16', 0],
    ['u16', 1],
    ['u16', 2],
    ['i16', 0], // link 0
    ['i16', -1],
    ['i16', 1], // triangle 1
    ['u16', NavmeshFlag.edge01Link | NavmeshFlag.door],
    ['u16', 0],
    ['u16', 0],
    ['u16', 2],
    ['u16', 3],
    ['i16', 0], // triangle 0
    ['i16', 1], // link 1
    ['i16', -1],
    ['u16', NavmeshFlag.edge12Link],
    ['u16', 0x4048],
    ['u32', 2], // links
    ['u32', NavmeshLinkType.portal],
    ['u32', 0x7001],
    ['u16', 5],
    ['u32', NavmeshLinkType.ledgeDown],
    ['u32', 0x7000],
    ['u16', 0],
    ['u32', 1], // one door triangle
    ['u16', 0],
    ['u32', PathingType.door],
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
    ...(options.extra ?? []),
  ]);
}

const record = (data: Uint8Array): GameRecord =>
  new GameRecord(db, {} as Plugin, 'NAVM', 0x7000, 0, new Fields([{ type: 'NVNM', data }]));

describe('navigation meshes', () => {
  it('reads vertices, triangles with their neighbours, links, doors, cover and the grid', () => {
    const navmesh = parseNavmesh(record(nvnm()));
    expect(navmesh?.world).toBe(0);
    expect(navmesh?.cell).toBe(0x5000);
    expect(navmesh?.vertices).toHaveLength(12);
    expect(navmesh?.triangles).toEqual([
      { vertices: [0, 1, 2], edges: [0, -1, 1], flags: 0x0401, cover: 0 },
      { vertices: [0, 2, 3], edges: [0, 1, -1], flags: 0x0002, cover: 0x4048 },
    ]);
    expect(navmesh?.links).toEqual([
      { type: NavmeshLinkType.portal, navmesh: 0x7001, triangle: 5 },
      { type: NavmeshLinkType.ledgeDown, navmesh: 0x7000, triangle: 0 },
    ]);
    expect(navmesh?.doors).toEqual([{ triangle: 0, type: PathingType.door, door: 0x6000 }]);
    expect(navmesh?.coverTriangles).toEqual([1]);
    expect(navmesh?.grid.cells).toEqual([[0, 1]]);
    expect(navmesh && navmeshTriangle(navmesh, 1)).toEqual([
      [0, 0, 0],
      [100, 100, 50],
      [0, 100, 50],
    ]);
  });

  it('tells a local neighbour from a link across an edge', () => {
    const navmesh = parseNavmesh(record(nvnm()));
    if (!navmesh) throw new Error('no navmesh');
    expect(triangleNeighbour(navmesh, 0, 0)).toEqual({ type: 0, navmesh: 0x7001, triangle: 5 });
    expect(triangleNeighbour(navmesh, 0, 1)).toBeUndefined();
    expect(triangleNeighbour(navmesh, 0, 2)).toBe(1);
    expect(triangleNeighbour(navmesh, 1, 0)).toBe(0);
    expect(triangleNeighbour(navmesh, 1, 1)).toEqual({ type: 2, navmesh: 0x7000, triangle: 0 });
    expect(triangleNeighbour(navmesh, 1, 2)).toBeUndefined();
    expect(triangleNeighbour(navmesh, 2, 0)).toBeUndefined();
  });

  it('places a worldspace navmesh by its grid position', () => {
    const place: Value[] = [
      ['u32', 0x16d71],
      ['i16', 1],
      ['i16', -43],
    ];
    const navmesh = parseNavmesh(record(nvnm({ place })));
    expect(navmesh?.world).toBe(0x16d71);
    expect(navmesh?.cell).toEqual({ x: -43, y: 1 });
  });

  it('rejects other versions, other pathing cells and data left over', () => {
    expect(() => parseNavmesh(record(nvnm({ version: 13 })))).toThrow(FormatError);
    expect(() => parseNavmesh(record(nvnm({ cellType: 0x1234 })))).toThrow(FormatError);
    expect(() => parseNavmesh(record(nvnm({ extra: [['u32', 7]] })))).toThrow(FormatError);
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
    expect(surface.near(80, 10, 0, 24)).toMatchObject({ navmesh: { formId: 0x7000 }, triangle: 0 });
    expect(surface.near(10, 80, 40, 24)).toMatchObject({ triangle: 1 });
  });
});
