// Terrain geometry for one exterior cell, built from its LAND: per quadrant a 17×17 grid of
// vertices with position, normal, vertex colour and blend weights for up to 8 textures (the
// base texture and the layers painted over it). Platform-independent.

import {
  CELL_SIZE,
  LAND_GRID,
  LAND_SPACING,
  QUADRANT_GRID,
  type LandData,
  type LandQuadrant,
} from '../world/land.ts';

/** Textures blended per quadrant: base + 7 layers (8 diffuse + 8 normal maps). */
export const TERRAIN_TEXTURES = 8;
/** Bytes per vertex: position f32x3, normal snorm8x4, colour unorm8x4, 8 weights unorm8. */
export const TERRAIN_STRIDE = 28;
/**
 * The engine's ground texture where a quadrant has no base texture, or a layer names LTEX 0 or
 * a land texture that does not exist (Skyrim.esm paints 13,000 layers with LTEX 0).
 */
export const DEFAULT_LAND_TEXTURE = 'textures\\landscape\\dirt02.dds';
export const DEFAULT_LAND_NORMAL = 'textures\\landscape\\dirt02_n.dds';

export interface TerrainQuadrantData {
  /** 17×17 vertices, TERRAIN_STRIDE bytes each. */
  readonly vertices: Uint8Array;
  /** LTEX form ids per texture slot (slot 0: base, undefined = default). */
  readonly textures: readonly (number | undefined)[];
  /** Bounding sphere (world space). */
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

/** Triangles of a 17×17 quadrant grid (the same for every quadrant). */
export function quadrantIndices(): Uint16Array {
  const quads = QUADRANT_GRID - 1;
  const indices = new Uint16Array(quads * quads * 6);
  let i = 0;
  for (let y = 0; y < quads; y++) {
    for (let x = 0; x < quads; x++) {
      const a = y * QUADRANT_GRID + x;
      const b = a + 1;
      const c = a + QUADRANT_GRID;
      const d = c + 1;
      // Counter-clockwise seen from above (+Z).
      indices.set([a, b, d, a, d, c], i);
      i += 6;
    }
  }
  return indices;
}

/**
 * Blend weights for a quadrant's point: each layer covers the ones below it by its opacity,
 * so the weights add up to 1. Keeps the base and the top 7 layers.
 */
function weightsAt(quadrant: LandQuadrant, point: number, out: Float32Array): void {
  const layers = quadrant.layers.slice(-(TERRAIN_TEXTURES - 1));
  out.fill(0);
  out[0] = 1;
  layers.forEach((layer, i) => {
    const alpha = Math.min(1, Math.max(0, layer.alpha[point] ?? 0));
    for (let k = 0; k <= i; k++) out[k] = (out[k] ?? 0) * (1 - alpha);
    out[i + 1] = alpha;
  });
}

export function buildTerrainCell(
  land: LandData,
  cellX: number,
  cellY: number,
): TerrainQuadrantData[] {
  const originX = cellX * CELL_SIZE;
  const originY = cellY * CELL_SIZE;
  const weights = new Float32Array(TERRAIN_TEXTURES);
  const quads = QUADRANT_GRID - 1;
  return land.quadrants.map((quadrant, q) => {
    const qx = q & 1;
    const qy = q >> 1;
    const vertices = new Uint8Array(QUADRANT_GRID * QUADRANT_GRID * TERRAIN_STRIDE);
    const view = new DataView(vertices.buffer);
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let y = 0; y < QUADRANT_GRID; y++) {
      for (let x = 0; x < QUADRANT_GRID; x++) {
        const gx = qx * quads + x;
        const gy = qy * quads + y;
        const point = gy * LAND_GRID + gx;
        const base = (y * QUADRANT_GRID + x) * TERRAIN_STRIDE;
        const z = land.heights[point] ?? 0;
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
        view.setFloat32(base, originX + gx * LAND_SPACING, true);
        view.setFloat32(base + 4, originY + gy * LAND_SPACING, true);
        view.setFloat32(base + 8, z, true);
        for (let k = 0; k < 3; k++) {
          const n = land.normals ? (land.normals[point * 3 + k] ?? 0) : k === 2 ? 1 : 0;
          view.setInt8(base + 12 + k, Math.round(Math.max(-1, Math.min(1, n)) * 127));
          view.setUint8(base + 16 + k, land.colors ? (land.colors[point * 3 + k] ?? 255) : 255);
        }
        view.setUint8(base + 19, 255);
        weightsAt(quadrant, y * QUADRANT_GRID + x, weights);
        for (let k = 0; k < TERRAIN_TEXTURES; k++) {
          view.setUint8(base + 20 + k, Math.round((weights[k] ?? 0) * 255));
        }
      }
    }
    const layers = quadrant.layers.slice(-(TERRAIN_TEXTURES - 1));
    const textures: (number | undefined)[] = [quadrant.base, ...layers.map((l) => l.texture)];
    const half = (quads * LAND_SPACING) / 2;
    const center: [number, number, number] = [
      originX + qx * quads * LAND_SPACING + half,
      originY + qy * quads * LAND_SPACING + half,
      (minZ + maxZ) / 2,
    ];
    return {
      vertices,
      textures,
      center,
      radius: Math.hypot(half, half, (maxZ - minZ) / 2),
    };
  });
}
