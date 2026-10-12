import { describe, expect, it } from 'vitest';
import {
  CELL_SIZE,
  LAND_GRID,
  QUADRANT_GRID,
  type LandData,
  type LandLayer,
} from '../world/land.ts';
import {
  buildTerrainCell,
  quadrantIndices,
  TERRAIN_STRIDE,
  TERRAIN_TEXTURES,
} from './terrain-data.ts';

const POINTS = LAND_GRID * LAND_GRID;
const QUADRANT_POINTS = QUADRANT_GRID * QUADRANT_GRID;

function layer(texture: number, opacity: number): LandLayer {
  return { texture, alpha: new Float32Array(QUADRANT_POINTS).fill(opacity) };
}

function land(layers: readonly LandLayer[] = []): LandData {
  const heights = new Float32Array(POINTS);
  heights.forEach((_, i) => {
    heights[i] = i; // unique per point
  });
  return {
    heights,
    normals: undefined,
    colors: undefined,
    quadrants: [
      { base: 0x10, layers },
      { base: undefined, layers: [] },
      { base: undefined, layers: [] },
      { base: undefined, layers: [] },
    ],
  };
}

const vertex = (vertices: Uint8Array, index: number): DataView =>
  new DataView(vertices.buffer, index * TERRAIN_STRIDE, TERRAIN_STRIDE);
const weights = (vertices: Uint8Array, index: number): number[] =>
  Array.from(vertices.subarray(index * TERRAIN_STRIDE + 20, index * TERRAIN_STRIDE + 28));

describe('quadrantIndices', () => {
  it('covers the 16×16 quads counter-clockwise seen from above', () => {
    const indices = quadrantIndices();
    expect(indices.length).toBe(16 * 16 * 6);
    expect(Array.from(indices.subarray(0, 3))).toEqual([0, 1, QUADRANT_GRID + 1]);
    expect(Math.max(...indices)).toBe(QUADRANT_POINTS - 1);
  });
});

describe('buildTerrainCell', () => {
  it('places quadrants in world space: SW, SE, NW, NE sharing their middle row', () => {
    const quadrants = buildTerrainCell(land(), 2, -3);
    expect(quadrants.length).toBe(4);
    const ne = quadrants[3];
    if (!ne) throw new Error('no quadrant');
    const first = vertex(ne.vertices, 0);
    expect(first.getFloat32(0, true)).toBe(2 * CELL_SIZE + CELL_SIZE / 2);
    expect(first.getFloat32(4, true)).toBe(-3 * CELL_SIZE + CELL_SIZE / 2);
    // Height of grid point (16, 16).
    expect(first.getFloat32(8, true)).toBe(16 * LAND_GRID + 16);
    const sw = quadrants[0];
    if (!sw) throw new Error('no quadrant');
    const last = vertex(sw.vertices, QUADRANT_POINTS - 1);
    expect(last.getFloat32(0, true)).toBe(2 * CELL_SIZE + CELL_SIZE / 2);
    expect(last.getFloat32(8, true)).toBe(16 * LAND_GRID + 16);
  });

  it('points up and is white without normals and colours', () => {
    const [sw] = buildTerrainCell(land(), 0, 0);
    if (!sw) throw new Error('no quadrant');
    const v = vertex(sw.vertices, 5);
    expect([v.getInt8(12), v.getInt8(13), v.getInt8(14)]).toEqual([0, 0, 127]);
    expect([v.getUint8(16), v.getUint8(17), v.getUint8(18), v.getUint8(19)]).toEqual([
      255, 255, 255, 255,
    ]);
  });

  it('lets each layer cover the ones below it, so the weights add up to one', () => {
    const [sw] = buildTerrainCell(land([layer(0x20, 0.5), layer(0x21, 0.5)]), 0, 0);
    if (!sw) throw new Error('no quadrant');
    expect(sw.textures).toEqual([0x10, 0x20, 0x21]);
    // base 0.25, first layer 0.25, second layer 0.5
    expect(weights(sw.vertices, 0)).toEqual([64, 64, 128, 0, 0, 0, 0, 0]);
  });

  it('a fully opaque layer hides everything below it', () => {
    const [sw] = buildTerrainCell(land([layer(0x20, 0.7), layer(0x21, 1)]), 0, 0);
    if (!sw) throw new Error('no quadrant');
    expect(weights(sw.vertices, 0)).toEqual([0, 0, 255, 0, 0, 0, 0, 0]);
  });

  it('blends the base and up to 7 layers', () => {
    const layers = Array.from({ length: TERRAIN_TEXTURES - 1 }, (_, i) => layer(0x20 + i, 0.5));
    const [sw] = buildTerrainCell(land(layers), 0, 0);
    if (!sw) throw new Error('no quadrant');
    expect(sw.textures.length).toBe(TERRAIN_TEXTURES);
    const sum = weights(sw.vertices, 0).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 255)).toBeLessThanOrEqual(TERRAIN_TEXTURES);
  });

  it('bounds each quadrant with a sphere around its points', () => {
    const [sw] = buildTerrainCell(land(), 0, 0);
    if (!sw) throw new Error('no quadrant');
    expect(sw.center[0]).toBe(CELL_SIZE / 4);
    expect(sw.center[1]).toBe(CELL_SIZE / 4);
    expect(sw.radius).toBeGreaterThan(Math.hypot(CELL_SIZE / 4, CELL_SIZE / 4));
  });
});
