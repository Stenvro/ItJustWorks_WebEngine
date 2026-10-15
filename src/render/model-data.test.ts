import { describe, expect, it } from 'vitest';
import { VertexAttribute } from '../formats/nif/blocks.ts';
import type { NiTriShapeDataBlock } from '../formats/nif/types.ts';
import { normalizeTexturePath, packTriShapeData } from './model-data.ts';

describe('normalizeTexturePath', () => {
  it.each([
    ['Textures\\Clutter\\Bucket.dds', 'textures\\clutter\\bucket.dds'],
    ['clutter/bucket.dds', 'textures\\clutter\\bucket.dds'],
    ['Data\\Textures\\Sky\\a.dds', 'textures\\sky\\a.dds'],
    ['skyrimhd\\build\\pc\\data\\textures\\plants\\potato01.dds', 'textures\\plants\\potato01.dds'],
    ['textures\\metadata\\x.dds', 'textures\\metadata\\x.dds'],
    ['  ', ''],
    ['textures\\clutter\\bucket.dds\0', 'textures\\clutter\\bucket.dds'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeTexturePath(input)).toBe(expected);
  });

  it.each(['\bNOR', '\bERR', 'textures\\a\u0001.dds', '\0\0'])(
    'gives no texture for the exporter leftover %j (a control character is no file name)',
    (input) => {
      expect(normalizeTexturePath(input)).toBe('');
    },
  );
});

describe('packTriShapeData', () => {
  const data: NiTriShapeDataBlock = {
    kind: 'ni-tri-shape-data',
    vertices: Float32Array.of(1, 2, 3, 4, 5, 6),
    normals: Float32Array.of(0, 0, 1, 0, 0, -1),
    tangents: Float32Array.of(1, 0, 0, 1, 0, 0),
    bitangents: Float32Array.of(0, 1, 0, 0, 1, 0),
    colors: Float32Array.of(1, 0.5, 0, 1, 0, 0, 0, 0),
    uvs: Float32Array.of(0, 1, 0.5, 0.25),
    boundCenter: [0, 0, 0],
    boundRadius: 1,
    triangles: Uint16Array.of(0, 1, 1),
  };

  it('packs older geometry into the BSTriShape layout', () => {
    const { layout, vertices, vertexCount } = packTriShapeData(data);
    expect(vertexCount).toBe(2);
    expect(layout).toEqual({
      stride: 32,
      attributes:
        VertexAttribute.vertex |
        VertexAttribute.fullPrecision |
        VertexAttribute.uv |
        VertexAttribute.normal |
        VertexAttribute.tangent |
        VertexAttribute.colors,
      uv: 16,
      normal: 20,
      tangent: 24,
      color: 28,
    });
    const view = new DataView(vertices.buffer);
    expect([
      view.getFloat32(32, true),
      view.getFloat32(36, true),
      view.getFloat32(40, true),
    ]).toEqual([4, 5, 6]);
    expect(view.getUint16(16 + 2, true)).toBe(0x3c00); // v = 1.0 as half
    expect([...vertices.subarray(20, 24)]).toEqual([128, 128, 255, 255]); // +Z, bitangent Y = 1
    expect([...vertices.subarray(52, 56)]).toEqual([128, 128, 0, 255]); // −Z
    expect([...vertices.subarray(28, 32)]).toEqual([255, 128, 0, 255]);
  });

  it('omits attributes the data does not have', () => {
    const { layout } = packTriShapeData({
      ...data,
      normals: undefined,
      tangents: undefined,
      bitangents: undefined,
      colors: undefined,
    });
    expect(layout).toMatchObject({ stride: 16, uv: 12, normal: -1, tangent: -1, color: -1 });
  });
});
