// Navigation meshes (NAVM): where actors can walk, as triangles over the floors, stairs and
// ramps of a cell, with their neighbours, the doors on them and a search grid. The NVNM field
// (version 12 in SSE): UESP "Skyrim Mod:Mod File Format/NVNM Field", OpenMW's ESM4 loader
// (components/esm4/loadnavm). Layout: docs/formats/esm.md ("Navigation meshes").
// Platform-independent.

import { BinaryReader, FormatError } from '../formats/binary-reader.ts';
import type { GameRecord, RecordDatabase } from './record-db.ts';

/** The NVNM version of Skyrim (and SSE). */
export const NAVMESH_VERSION = 12;

/** NVNM triangle flags (xEdit). */
export const NavmeshFlag = {
  edge01Link: 0x0001,
  edge12Link: 0x0002,
  edge20Link: 0x0004,
  deleted: 0x0008,
  noLargeCreatures: 0x0010,
  overlapping: 0x0020,
  preferred: 0x0040,
  water: 0x0200,
  door: 0x0400,
  found: 0x0800,
} as const;

export interface NavmeshTriangle {
  /** Vertex indices. */
  readonly vertices: readonly [number, number, number];
  /** The triangle across each edge (0–1, 1–2, 2–0); −1 for none (or a link to another mesh). */
  readonly edges: readonly [number, number, number];
  /** NavmeshFlag bits. */
  readonly flags: number;
  /** Cover flags (where cover is along the edges). */
  readonly cover: number;
}

/** A triangle's edge leading into another cell's navigation mesh. */
export interface NavmeshLink {
  readonly type: number;
  /** The other NAVM. */
  readonly navmesh: number;
  readonly triangle: number;
}

/** A triangle in front of a door (teleport): the door reference. */
export interface NavmeshDoor {
  readonly triangle: number;
  readonly type: number;
  readonly door: number;
}

export interface Navmesh {
  readonly formId: number;
  /** The worldspace, 0 for interiors. */
  readonly world: number;
  /** Interiors and worlds other than Tamriel: the cell; Tamriel: its grid (x, y). */
  readonly cell: number | { readonly x: number; readonly y: number };
  /** Game units, xyz per vertex, world coordinates. */
  readonly vertices: Float32Array;
  readonly triangles: readonly NavmeshTriangle[];
  readonly links: readonly NavmeshLink[];
  readonly doors: readonly NavmeshDoor[];
  /** Triangles with cover. */
  readonly coverTriangles: readonly number[];
  /** The search grid: `divisor`² cells over the bounds, each listing its triangles. */
  readonly grid: {
    readonly divisor: number;
    readonly cellSize: readonly [number, number];
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
    readonly cells: readonly (readonly number[])[];
  };
}

/** Tamriel: the NVNM's place is a grid position instead of a cell. */
const TAMRIEL = 0x3c;

/** Reads a NAVM's NVNM field; undefined if the record has none (a deleted navmesh). */
export function parseNavmesh(record: GameRecord): Navmesh | undefined {
  const nvnm = record.fields.first('NVNM');
  if (!nvnm) return undefined;
  const reader = new BinaryReader(nvnm);
  const version = reader.u32();
  if (version !== NAVMESH_VERSION) {
    throw new FormatError(
      `NVNM version ${String(version)}, expected ${String(NAVMESH_VERSION)}`,
      0,
    );
  }
  reader.u32(); // a checksum of the mesh, or flags (not documented)
  const formIdAt = (): number => {
    const offset = reader.offset;
    reader.skip(4);
    return record.formIdAt(nvnm, offset);
  };
  const world = formIdAt();
  let cell: Navmesh['cell'];
  if (world === TAMRIEL) {
    const y = reader.i16();
    const x = reader.i16();
    cell = { x, y };
  } else {
    cell = formIdAt();
  }
  const vertexCount = reader.u32();
  const vertices = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertices.length; i++) vertices[i] = reader.f32();
  const triangleCount = reader.u32();
  const triangles: NavmeshTriangle[] = [];
  for (let i = 0; i < triangleCount; i++) {
    const a = reader.u16();
    const b = reader.u16();
    const c = reader.u16();
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) {
      throw new FormatError(`NVNM triangle ${String(i)} names a missing vertex`, reader.offset);
    }
    const edges: [number, number, number] = [reader.i16(), reader.i16(), reader.i16()];
    triangles.push({ vertices: [a, b, c], edges, flags: reader.u16(), cover: reader.u16() });
  }
  const links: NavmeshLink[] = [];
  const linkCount = reader.u32();
  for (let i = 0; i < linkCount; i++) {
    const type = reader.u32();
    const navmesh = formIdAt();
    links.push({ type, navmesh, triangle: reader.u16() });
  }
  const doors: NavmeshDoor[] = [];
  const doorCount = reader.u32();
  for (let i = 0; i < doorCount; i++) {
    const triangle = reader.u16();
    const type = reader.u32();
    doors.push({ triangle, type, door: formIdAt() });
  }
  const coverTriangles: number[] = [];
  const coverCount = reader.u32();
  for (let i = 0; i < coverCount; i++) coverTriangles.push(reader.u16());
  const divisor = reader.u32();
  const cellSize: [number, number] = [reader.f32(), reader.f32()];
  const min: [number, number, number] = [reader.f32(), reader.f32(), reader.f32()];
  const max: [number, number, number] = [reader.f32(), reader.f32(), reader.f32()];
  const cells: number[][] = [];
  for (let i = 0; i < divisor * divisor; i++) {
    const count = reader.u32();
    const list: number[] = [];
    for (let j = 0; j < count; j++) list.push(reader.u16());
    cells.push(list);
  }
  if (reader.remaining !== 0) {
    throw new FormatError(`NVNM: ${String(reader.remaining)} bytes left over`, reader.offset);
  }
  return {
    formId: record.formId,
    world,
    cell,
    vertices,
    triangles,
    links,
    doors,
    coverTriangles,
    grid: { divisor, cellSize, min, max, cells },
  };
}

/** A triangle's corners (game units). */
export function navmeshTriangle(
  navmesh: Navmesh,
  index: number,
): [[number, number, number], [number, number, number], [number, number, number]] {
  const triangle = navmesh.triangles[index];
  const corner = (vertex: number): [number, number, number] => [
    navmesh.vertices[vertex * 3] ?? 0,
    navmesh.vertices[vertex * 3 + 1] ?? 0,
    navmesh.vertices[vertex * 3 + 2] ?? 0,
  ];
  const [a = 0, b = 0, c = 0] = triangle?.vertices ?? [];
  return [corner(a), corner(b), corner(c)];
}

/** A point lies on a navigation mesh within this height of it (game units): the meshes lie a
 * little above or below the floors they follow. */
export const NAVMESH_TOLERANCE = 24;

/** The navigation meshes of a cell (its NAVM children), deleted ones left out. */
export async function cellNavmeshes(db: RecordDatabase, cell: number): Promise<Navmesh[]> {
  const meshes: Navmesh[] = [];
  for (const id of db.cellReferences(cell)) {
    const location = db.locate(id);
    if (!location || db.typeAt(location) !== 'NAVM') continue;
    const record = await db.read(location);
    if (record.deleted) continue;
    const navmesh = parseNavmesh(record);
    if (navmesh) meshes.push(navmesh);
  }
  return meshes;
}

/** The size of the bins NavmeshSurface sorts triangles into (game units). */
const SURFACE_BIN = 256;

/**
 * The walkable surface of a set of navigation meshes, for asking whether actors walk at a
 * point: triangles sorted into square bins by their bounds.
 */
export class NavmeshSurface {
  readonly #meshes: readonly Navmesh[];
  readonly #bins = new Map<string, [number, number][]>();

  constructor(meshes: readonly Navmesh[]) {
    this.#meshes = meshes;
    meshes.forEach((navmesh, mesh) => {
      navmesh.triangles.forEach((triangle, index) => {
        if ((triangle.flags & NavmeshFlag.deleted) !== 0) return;
        const corners = navmeshTriangle(navmesh, index);
        const xs = corners.map((corner) => corner[0]);
        const ys = corners.map((corner) => corner[1]);
        for (let bx = binOf(Math.min(...xs)); bx <= binOf(Math.max(...xs)); bx++) {
          for (let by = binOf(Math.min(...ys)); by <= binOf(Math.max(...ys)); by++) {
            const key = `${String(bx)},${String(by)}`;
            const list = this.#bins.get(key) ?? [];
            list.push([mesh, index]);
            this.#bins.set(key, list);
          }
        }
      });
    });
  }

  /**
   * The navmesh's height over a point nearest to `z`, if it covers the point within
   * `tolerance` of that height (navmeshes lie a little above or below the floors they follow).
   */
  heightNear(x: number, y: number, z: number, tolerance: number): number | undefined {
    let best: number | undefined;
    for (const [mesh, index] of this.#bins.get(`${String(binOf(x))},${String(binOf(y))}`) ?? []) {
      const navmesh = this.#meshes[mesh];
      if (!navmesh) continue;
      const [a, b, c] = navmeshTriangle(navmesh, index);
      // Barycentric coordinates in the horizontal plane.
      const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(det) < 1e-9) continue;
      const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / det;
      const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / det;
      const w = 1 - u - v;
      if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
      const height = u * a[2] + v * b[2] + w * c[2];
      if (Math.abs(height - z) > tolerance) continue;
      if (best === undefined || Math.abs(height - z) < Math.abs(best - z)) best = height;
    }
    return best;
  }
}

const binOf = (v: number): number => Math.floor(v / SURFACE_BIN);
