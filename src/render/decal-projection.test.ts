import { describe, expect, it } from 'vitest';
import type { CellDecal } from '../world/cell-loader.ts';
import { identity } from './math.ts';
import { projectDecals } from './decal-projection.ts';
import type { ModelPart } from './model-data.ts';
import { rayTriangle, type PlacedPart } from './raycast.ts';

/** A 200 × 200 floor quad at height `z` (float32 positions, as SSE stores them). */
function floor(z: number): PlacedPart {
  const vertices = new Float32Array([-100, -100, z, 100, -100, z, 100, 100, z, -100, 100, z]);
  const part = {
    name: 'floor',
    block: 0,
    shader: 0,
    alphaProperty: -1,
    world: identity(),
    layout: { stride: 12, attributes: 0x1, uv: -1, normal: -1, tangent: -1, color: -1 },
    vertices: new Uint8Array(vertices.buffer),
    vertexCount: 4,
    indices: Uint16Array.of(0, 1, 2, 0, 2, 3),
    material: { kind: 'lighting' },
    alpha: undefined,
    center: [0, 0, z],
    radius: 142,
  } as unknown as ModelPart;
  return { part, instanceWorld: identity(), center: [0, 0, z], radius: 142 };
}

/** A decal 100 units above the origin projecting straight down (+Y = −Z). */
function decalAbove(): CellDecal {
  const box = identity();
  box[5] = 0;
  box[6] = -32; // Y column: down, 32 deep
  box[9] = 32;
  box[10] = 0; // Z column: north
  box[14] = 100;
  return {
    reference: 1,
    base: 2,
    textureSet: { editorId: 'Test', textures: [], flags: 0, decal: undefined },
    box,
    rect: [0, 0, 1, 1],
  };
}

describe('rayTriangle', () => {
  it('finds the distance to a triangle and misses beside it', () => {
    expect(rayTriangle([0.2, 0.2, 5], [0, 0, -1], [0, 0, 0], [1, 0, 0], [0, 1, 0])).toBeCloseTo(
      5,
      6,
    );
    expect(rayTriangle([2, 2, 5], [0, 0, -1], [0, 0, 0], [1, 0, 0], [0, 1, 0])).toBe(Infinity);
  });
});

describe('projectDecals', () => {
  it('moves a decal onto the first surface along its projection axis', () => {
    const [moved] = projectDecals([decalAbove()], [floor(-20), floor(10)]);
    expect(moved?.box[14]).toBeCloseTo(10, 4);
  });

  it('lands on the landscape when no object is in the way', () => {
    const [moved] = projectDecals([decalAbove()], [], () => -40);
    expect(moved?.box[14]).toBeCloseTo(-40, 0);
  });

  it('stays at its reference when nothing is within reach', () => {
    const [moved] = projectDecals([decalAbove()], [floor(5000)]);
    expect(moved?.box[14]).toBe(100);
  });
});
