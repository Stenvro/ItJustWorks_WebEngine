import { describe, expect, it } from 'vitest';
import { identity } from './math.ts';
import {
  clippedDecalPolygons,
  landDecalPart,
  worldDecalBox,
  worldDecalFaceLimit,
  type DecalLand,
  type WorldDecalLook,
} from './world-decal.ts';
import type { LightingMaterial } from './model-data.ts';

/** A box 20 wide (X), 20 high (Z), projecting down (-Z) at the origin: lying on a floor. */
function floorBox(depth: number): Float32Array {
  // X across, Y along the projection (down), Z up the texture (north).
  const placed = new Float32Array([20, 0, 0, 0, 0, 0, -1, 0, 0, 20, 0, 0, 0, 0, 0, 1]);
  return worldDecalBox(placed, depth);
}

/** A floor of two triangles 200 across, counter-clockwise from above, at height `z`. */
function floor(z: number): { positions: Float32Array; indices: number[] } {
  return {
    positions: new Float32Array([-100, -100, z, 100, -100, z, 100, 100, z, -100, 100, z]),
    indices: [0, 1, 2, 0, 2, 3],
  };
}

const UP = [0, 0, 1] as const;

describe('worldDecalFaceLimit', () => {
  it('is the cosine of the impact angle threshold, at least 0.01', () => {
    expect(worldDecalFaceLimit(0)).toBe(1);
    expect(worldDecalFaceLimit(60)).toBeCloseTo(0.5);
    expect(worldDecalFaceLimit(90)).toBe(0.01);
  });
});

describe('worldDecalBox', () => {
  it('makes the box its depth either side of the surface', () => {
    const box = floorBox(32);
    expect(Math.hypot(box[4] ?? 0, box[5] ?? 0, box[6] ?? 0)).toBeCloseTo(64);
    expect(box[0]).toBe(20);
  });
});

describe('clippedDecalPolygons', () => {
  it('clips the triangles under the box to its width and height', () => {
    const { positions, indices } = floor(0);
    const polygons = clippedDecalPolygons(
      { positions, normals: undefined, indices, world: identity() },
      floorBox(32),
      UP,
      worldDecalFaceLimit(15),
    );
    const points = polygons.flat().map((v) => v.position);
    expect(polygons.length).toBe(2);
    for (const [x, y] of points) {
      expect(Math.abs(x)).toBeLessThanOrEqual(10 + 1e-4);
      expect(Math.abs(y)).toBeLessThanOrEqual(10 + 1e-4);
    }
    // The clipped corners reach the box's edges.
    expect(Math.max(...points.map(([x]) => x))).toBeCloseTo(10);
  });

  it('leaves out faces turned beyond the angle threshold and those past the depth', () => {
    const { positions } = floor(0);
    const reversed = [0, 2, 1, 0, 3, 2];
    const shape = { positions, normals: undefined, indices: reversed, world: identity() };
    expect(clippedDecalPolygons(shape, floorBox(32), UP, worldDecalFaceLimit(80))).toEqual([]);
    const low = floor(-40);
    expect(
      clippedDecalPolygons(
        { ...low, normals: undefined, world: identity() },
        floorBox(32),
        UP,
        worldDecalFaceLimit(15),
      ),
    ).toEqual([]);
    expect(
      clippedDecalPolygons(
        { ...low, normals: undefined, world: identity() },
        floorBox(48),
        UP,
        worldDecalFaceLimit(15),
      ).length,
    ).toBe(2);
  });
});

describe('landDecalPart', () => {
  const material = { kind: 'lighting', flags1: 0x2, flags2: 0x20 } as unknown as LightingMaterial;
  const look: WorldDecalLook = { material, alpha: undefined, color: [1, 0, 0], rect: [0, 0, 1, 1] };

  it('builds the decal from the land grid under the box, coloured, its texture across it', () => {
    const grid = 33;
    const land: DecalLand = {
      heights: new Float32Array(grid * grid),
      normals: undefined,
      origin: [-2048, -2048],
      grid,
      spacing: 128,
    };
    const part = landDecalPart(land, floorBox(32), UP, worldDecalFaceLimit(15), look);
    expect(part).toBeDefined();
    if (!part) return;
    const view = new DataView(part.vertices.buffer);
    const stride = part.layout.stride;
    for (let v = 0; v < part.vertexCount; v++) {
      expect(Math.abs(view.getFloat32(v * stride, true))).toBeLessThanOrEqual(10 + 1e-4);
      expect(part.vertices[v * stride + part.layout.color]).toBe(255);
      expect(part.vertices[v * stride + part.layout.color + 1]).toBe(0);
    }
    expect(part.material?.kind === 'lighting' && part.material.flags1 & 0x2).toBe(0);
  });

  it('takes none from a land that does not reach the box', () => {
    const land: DecalLand = {
      heights: new Float32Array(33 * 33),
      normals: undefined,
      origin: [4096, 4096],
      grid: 33,
      spacing: 128,
    };
    expect(landDecalPart(land, floorBox(32), UP, worldDecalFaceLimit(15), look)).toBeUndefined();
  });
});
