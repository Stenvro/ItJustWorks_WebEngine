// Landscape (LAND) of an exterior cell: a 33×33 grid of heights, normals and vertex
// colours, and per quadrant a base texture plus blended layers. Layout: docs/formats/esm.md
// ("Landscape"); UESP "Skyrim Mod:Mod File Format/LAND".

import { view } from '../formats/esm/fields.ts';
import type { GameRecord } from './record-db.ts';

/** Points per cell side (32 quads of 128 units). */
export const LAND_GRID = 33;
/** Points per quadrant side: quadrants share their middle row/column. */
export const QUADRANT_GRID = 17;
export const CELL_SIZE = 4096;
export const LAND_SPACING = CELL_SIZE / (LAND_GRID - 1);

export interface LandLayer {
  /** LTEX form id (global). */
  readonly texture: number;
  /** Opacity per quadrant point (17×17, row by row from the south-west corner). */
  readonly alpha: Float32Array;
}

export interface LandQuadrant {
  /** Base LTEX form id; undefined: the engine's default (dirt02). */
  readonly base: number | undefined;
  /** Additional layers, bottom to top. */
  readonly layers: readonly LandLayer[];
}

export interface LandData {
  /** Heights in game units relative to the cell origin, row by row from the south-west. */
  readonly heights: Float32Array;
  /** Unit normals, xyz per point; undefined if the record has none. */
  readonly normals: Float32Array | undefined;
  /** RGB 0..255 per point; undefined if none. */
  readonly colors: Uint8Array | undefined;
  /** Quadrants: 0 south-west, 1 south-east, 2 north-west, 3 north-east. */
  readonly quadrants: readonly LandQuadrant[];
}

const POINTS = LAND_GRID * LAND_GRID;

/** VHGT: an offset, then a delta per point that accumulates along rows and down column 0. */
export function decodeHeights(vhgt: Uint8Array): Float32Array {
  const heights = new Float32Array(POINTS);
  if (vhgt.length < 4 + POINTS) return heights;
  const data = view(vhgt);
  let rowStart = data.getFloat32(0, true);
  for (let y = 0; y < LAND_GRID; y++) {
    rowStart += data.getInt8(4 + y * LAND_GRID);
    let value = rowStart;
    heights[y * LAND_GRID] = value * 8;
    for (let x = 1; x < LAND_GRID; x++) {
      value += data.getInt8(4 + y * LAND_GRID + x);
      heights[y * LAND_GRID + x] = value * 8;
    }
  }
  return heights;
}

/** VNML: signed bytes per component. */
function decodeNormals(vnml: Uint8Array): Float32Array | undefined {
  if (vnml.length < POINTS * 3) return undefined;
  const normals = new Float32Array(POINTS * 3);
  const data = view(vnml);
  for (let i = 0; i < POINTS; i++) {
    const x = data.getInt8(i * 3);
    const y = data.getInt8(i * 3 + 1);
    const z = data.getInt8(i * 3 + 2);
    const length = Math.hypot(x, y, z) || 1;
    normals[i * 3] = x / length;
    normals[i * 3 + 1] = y / length;
    normals[i * 3 + 2] = z / length;
  }
  return normals;
}

/** What parseLand needs of a record: its fields and global form ids. */
export type LandRecord = Pick<GameRecord, 'fields' | 'formIdAt'>;

export function parseLand(record: LandRecord): LandData {
  const vhgt = record.fields.first('VHGT');
  const vnml = record.fields.first('VNML');
  const vclr = record.fields.first('VCLR');
  const quadrants = Array.from({ length: 4 }, () => ({
    base: undefined as number | undefined,
    layers: [] as { layer: number; texture: number; alpha: Float32Array }[],
  }));
  let current: { texture: number; alpha: Float32Array } | undefined;
  for (const field of record.fields.list) {
    if (field.type === 'BTXT' && field.data.length >= 5) {
      const quadrant = quadrants[(field.data[4] ?? 0) & 3];
      const texture = record.formIdAt(field.data);
      if (quadrant) quadrant.base = texture === 0 ? undefined : texture;
      current = undefined;
    } else if (field.type === 'ATXT' && field.data.length >= 8) {
      const quadrant = quadrants[(field.data[4] ?? 0) & 3];
      const layer = view(field.data).getUint16(6, true);
      current = {
        texture: record.formIdAt(field.data),
        alpha: new Float32Array(QUADRANT_GRID * QUADRANT_GRID),
      };
      quadrant?.layers.push({ layer, ...current });
    } else if (field.type === 'VTXT' && current) {
      const data = view(field.data);
      for (let offset = 0; offset + 8 <= field.data.length; offset += 8) {
        const position = data.getUint16(offset, true);
        if (position < current.alpha.length)
          current.alpha[position] = data.getFloat32(offset + 4, true);
      }
    }
  }
  return {
    heights: vhgt ? decodeHeights(vhgt) : new Float32Array(POINTS),
    normals: vnml ? decodeNormals(vnml) : undefined,
    colors: vclr && vclr.length >= POINTS * 3 ? vclr.slice(0, POINTS * 3) : undefined,
    quadrants: quadrants.map((q) => ({
      base: q.base,
      layers: q.layers
        .sort((a, b) => a.layer - b.layer)
        .map(({ texture, alpha }) => ({ texture, alpha })),
    })),
  };
}

export interface LandTexture {
  readonly diffuse: string;
  readonly normal: string;
  /** Specular exponent (LTEX SNAM). */
  readonly specularExponent: number;
  /** LTEX INAM 0x1: a snow texture (its diffuse alpha is the snow mask). */
  readonly snow: boolean;
  /** Grass that grows on this texture (GRAS form ids, LTEX GNAM). */
  readonly grass: readonly number[];
}

/** LTEX → its texture set's diffuse and normal maps. */
export async function landTexture(
  get: (formId: number) => Promise<GameRecord | undefined>,
  ltex: number,
): Promise<LandTexture | undefined> {
  const record = await get(ltex);
  if (record?.type !== 'LTEX') return undefined;
  const set = await get(record.formIdField('TNAM') ?? 0);
  const path = (type: string): string => {
    const value = set?.fields.zstring(type) ?? '';
    if (value === '') return '';
    const normalized = value.replaceAll('/', '\\').toLowerCase();
    return normalized.startsWith('textures\\') ? normalized : `textures\\${normalized}`;
  };
  return {
    diffuse: path('TX00'),
    normal: path('TX01'),
    specularExponent: record.fields.first('SNAM')?.[0] ?? 30,
    // INAM (SSE) flags: 0x1 is snow.
    snow: ((record.fields.first('INAM')?.[0] ?? 0) & 0x1) !== 0,
    grass: record.fields.all('GNAM').flatMap((data) => {
      const id = data.length >= 4 ? record.formIdAt(data) : 0;
      return id === 0 ? [] : [id];
    }),
  };
}

/**
 * Height of a cell's landscape at a world position (bilinear between its vertices), or
 * undefined outside the cell.
 */
export function landHeightAt(
  land: LandData,
  cellX: number,
  cellY: number,
  x: number,
  y: number,
): number | undefined {
  const localX = x - cellX * CELL_SIZE;
  const localY = y - cellY * CELL_SIZE;
  if (localX < 0 || localY < 0 || localX > CELL_SIZE || localY > CELL_SIZE) return undefined;
  const gx = Math.min(LAND_GRID - 1.001, localX / LAND_SPACING);
  const gy = Math.min(LAND_GRID - 1.001, localY / LAND_SPACING);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const tx = gx - x0;
  const ty = gy - y0;
  const at = (ix: number, iy: number): number => land.heights[iy * LAND_GRID + ix] ?? 0;
  return (
    at(x0, y0) * (1 - tx) * (1 - ty) +
    at(x0 + 1, y0) * tx * (1 - ty) +
    at(x0, y0 + 1) * (1 - tx) * ty +
    at(x0 + 1, y0 + 1) * tx * ty
  );
}
