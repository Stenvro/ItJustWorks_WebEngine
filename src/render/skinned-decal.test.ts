import { describe, expect, it } from 'vitest';
import { fromHalf, type PartSkin } from './skinning.ts';
import { identity, toHalf } from './math.ts';
import type { ModelPart } from './model-data.ts';
import {
  rigidDecalPart,
  skinnedDecalMaterial,
  skinnedDecalModel,
  skinnedDecalPart,
  triangleInUnitBox,
} from './skinned-decal.ts';

const STRIDE = 44;
const LAYOUT = {
  stride: STRIDE,
  attributes: 0,
  uv: 16,
  normal: 20,
  tangent: 24,
  color: 28,
  skinning: 32,
};

/** A row of quads along X (x = 0..columns, y = 0..1, z = 0), facing +Z, all on bone 0. */
function strip(columns: number, partitions?: PartSkin['partitions']): ModelPart {
  const count = (columns + 1) * 2;
  const vertices = new Uint8Array(count * STRIDE);
  const view = new DataView(vertices.buffer);
  for (let i = 0; i < count; i++) {
    const base = i * STRIDE;
    view.setFloat32(base, Math.floor(i / 2), true);
    view.setFloat32(base + 4, i % 2, true);
    view.setUint16(base + 16, toHalf(0.25), true);
    vertices.set([128, 128, 255, 128], base + 20);
    view.setUint16(base + 32, toHalf(1), true);
  }
  const indices: number[] = [];
  for (let c = 0; c < columns; c++) {
    const a = c * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const skin: PartSkin = {
    bones: [1],
    names: ['Bone'],
    bind: identity(),
    rest: identity(),
    ...(partitions && { partitions }),
  };
  return {
    name: 'Body',
    block: 1,
    shader: 2,
    alphaProperty: -1,
    world: identity(),
    layout: LAYOUT,
    vertices,
    vertexCount: count,
    indices: Uint16Array.from(indices),
    material: undefined,
    alpha: undefined,
    center: [columns / 2, 0.5, 0],
    radius: columns,
    skin,
  };
}

const look = {
  textures: ['textures\\blood\\decal.dds', 'textures\\blood\\decal_n.dds'],
  flags: 0x2,
  shininess: 30,
  color: [1, 0.5, 0.5] as const,
  noSpecular: false,
  modelSpaceNormals: false,
};

/** A box 2 wide (X), 4 deep (Y), 2 high (Z) centred at `x`, projecting along -Z onto the strip. */
function box(x: number): Float32Array {
  // Unit cube X → world X × 2, Y → world Z × 4, Z → world Y × 2.
  return Float32Array.from([2, 0, 0, 0, 0, 0, 4, 0, 0, 2, 0, 0, x, 0.5, 0, 1]);
}

describe('skinned decals', () => {
  it('finds triangles that overlap the unit cube', () => {
    expect(triangleInUnitBox([0, 0, 0], [1, 0, 0], [0, 1, 0])).toBe(true);
    expect(triangleInUnitBox([2, 0, 0], [3, 0, 0], [2, 1, 0])).toBe(false);
    // Crossing the cube with every vertex outside it.
    expect(triangleInUnitBox([-2, 0, 0], [2, 0.1, 0], [0, 3, 0])).toBe(true);
    // Beside a corner: only an edge cross product separates it.
    expect(triangleInUnitBox([0.9, 0.9, -1], [0.9, 0.9, 1], [2, -0.2, 0])).toBe(false);
  });

  it('copies the posed triangles in the box with their weights and box texture coordinates', () => {
    const pose = { worlds: identity(), skeleton: { nodeByName: new Map([['bone', 0]]) } };
    const { material, alpha } = skinnedDecalMaterial(look);
    const part = skinnedDecalPart(
      { part: strip(10), world: identity(), pose },
      box(5),
      [0, 0, 1, 1],
      material,
      alpha,
      look.color,
    );
    expect(part).toBeDefined();
    if (!part) return;
    // Columns 4 and 5 lie inside, columns 3 and 6 touch the box's sides: four quads.
    expect(part.indices.length).toBe(4 * 6);
    expect(part.vertexCount).toBe(10);
    const view = new DataView(part.vertices.buffer);
    for (let v = 0; v < part.vertexCount; v++) {
      const x = view.getFloat32(v * STRIDE, true);
      const u = fromHalf(view.getUint16(v * STRIDE + 16, true));
      expect(u).toBeCloseTo((x - 5) / 2 + 0.5, 2);
      // Weights kept; the decal's colour on the vertices.
      expect(fromHalf(view.getUint16(v * STRIDE + 32, true))).toBe(1);
      expect([...part.vertices.subarray(v * STRIDE + 28, v * STRIDE + 31)]).toEqual([
        255, 128, 128,
      ]);
    }
    expect(part.skin?.names).toEqual(['Bone']);
    expect(part.material?.kind === 'lighting' && part.material.flags1 & 0xc000000).toBe(0xc000000);
    expect(part.alpha?.flags).toBe(0xed);
  });

  it('follows the pose the body has at the hit', () => {
    // The bone moved 3 units along X: the box at 5 now finds the strip's columns about 2.
    const moved = identity();
    moved[12] = 3;
    const pose = { worlds: moved, skeleton: { nodeByName: new Map([['bone', 0]]) } };
    const model = skinnedDecalModel(
      [{ part: strip(10), world: identity(), pose }],
      box(5),
      [0, 0, 1, 1],
      look,
    );
    const view = new DataView(model?.parts[0]?.vertices.buffer ?? new ArrayBuffer(0));
    const xs = Array.from({ length: model?.parts[0]?.vertexCount ?? 0 }, (_, v) =>
      view.getFloat32(v * STRIDE, true),
    );
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(4);
  });

  it('keeps the partitions, and leaves out those the equipment hides', () => {
    const pose = { worlds: identity(), skeleton: { nodeByName: new Map([['bone', 0]]) } };
    const partitions = [
      { first: 0, count: 30, bodyPart: 32 },
      { first: 30, count: 30, bodyPart: 38 },
    ];
    const { material, alpha } = skinnedDecalMaterial(look);
    const all = skinnedDecalPart(
      { part: strip(10, partitions), world: identity(), pose },
      box(5),
      [0, 0, 1, 1],
      material,
      alpha,
    );
    expect(all?.skin?.partitions).toEqual([
      { first: 0, count: 12, bodyPart: 32 },
      { first: 12, count: 12, bodyPart: 38 },
    ]);
    const hidden = skinnedDecalPart(
      { part: strip(10, partitions), world: identity(), pose, partitionVisible: (b) => b !== 38 },
      box(5),
      [0, 0, 1, 1],
      material,
      alpha,
    );
    expect(hidden?.indices.length).toBe(12);
    expect(
      skinnedDecalPart(
        { part: strip(10), world: identity(), pose },
        box(20),
        [0, 0, 1, 1],
        material,
        alpha,
      ),
    ).toBeUndefined();
  });
});

describe('decals on rigid shapes', () => {
  /** The strip as a rigid shape hung on a skeleton node (a helmet, a shield). */
  const rigid = (): ModelPart => {
    const part: ModelPart = { ...strip(10) };
    delete (part as { skin?: unknown }).skin;
    const local = identity();
    local[13] = 7;
    return { ...part, node: 2, local };
  };

  it("copies the shape's triangles in the box, unskinned, on the node it hangs on", () => {
    const { material, alpha } = skinnedDecalMaterial(look);
    // The node stands 3 units along X: the box at 5 meets the shape's columns about 2.
    const world = identity();
    world[12] = 3;
    const part = rigidDecalPart(
      { part: rigid(), world },
      box(5),
      [0, 0, 1, 1],
      material,
      alpha,
      look.color,
      0,
    );
    expect(part).toBeDefined();
    if (!part) return;
    const view = new DataView(part.vertices.buffer);
    const xs = Array.from({ length: part.vertexCount }, (_, v) =>
      view.getFloat32(v * STRIDE, true),
    );
    // Copied as the shape has them (its own space), not where they stand.
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(4);
    for (let v = 0; v < part.vertexCount; v++) {
      const u = fromHalf(view.getUint16(v * STRIDE + 16, true));
      expect(u).toBeCloseTo((view.getFloat32(v * STRIDE, true) + 3 - 5) / 2 + 0.5, 2);
    }
    expect(part.skin).toBeUndefined();
    expect(part.node).toBe(0);
    expect(part.local?.[13]).toBe(7);
    const flags1 = part.material?.kind === 'lighting' ? part.material.flags1 : 0;
    // A decal, not skinned.
    expect(flags1 & 0xc000000).toBe(0xc000000);
    expect(flags1 & 0x2).toBe(0);
  });

  it('makes none for a skinned shape or a box beside the shape', () => {
    const { material, alpha } = skinnedDecalMaterial(look);
    expect(
      rigidDecalPart({ part: strip(10), world: identity() }, box(5), [0, 0, 1, 1], material, alpha),
    ).toBeUndefined();
    expect(
      rigidDecalPart({ part: rigid(), world: identity() }, box(20), [0, 0, 1, 1], material, alpha),
    ).toBeUndefined();
  });
});
