import { describe, expect, it } from 'vitest';
import { BinaryReader } from '../binary-reader.ts';
import { BLOCK_PARSERS, decodeVertexDesc, stripsToTriangles, VertexAttribute } from './blocks.ts';

describe('decodeVertexDesc', () => {
  it('unpacks stride, offsets and attribute flags', () => {
    // Typical static SSE vertex: position + bitangent X (16), UV (4), normal (4),
    // tangent (4), color (4) = 32 bytes.
    const low = 0x8 | (4 << 8) | (5 << 16) | (6 << 20) | (7 << 24);
    const attributes =
      VertexAttribute.vertex |
      VertexAttribute.uv |
      VertexAttribute.normal |
      VertexAttribute.tangent |
      VertexAttribute.colors |
      VertexAttribute.fullPrecision;
    const desc = decodeVertexDesc(low, attributes << 12);
    expect(desc).toEqual({
      stride: 32,
      uvOffset: 16,
      normalOffset: 20,
      tangentOffset: 24,
      colorOffset: 28,
      skinningOffset: 0,
      eyeOffset: 0,
      attributes,
    });
  });
});

describe('stripsToTriangles', () => {
  it('alternates the winding and drops degenerate triangles', () => {
    const triangles = stripsToTriangles([
      Uint16Array.of(0, 1, 2, 3, 3, 4),
      Uint16Array.of(5, 6, 7),
    ]);
    expect(Array.from(triangles)).toEqual([0, 1, 2, 1, 3, 2, 5, 6, 7]);
  });
});

describe('furniture markers', () => {
  it('read each position: offset, heading, animation type and entry points', () => {
    const bytes = new Uint8Array(4 + 4 + 2 * 20);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, 0, true); // the name: string 0 ("FRN")
    view.setUint32(4, 2, true);
    const position = (
      at: number,
      offset: number[],
      heading: number,
      type: number,
      entry: number,
    ) => {
      offset.forEach((value, i) => {
        view.setFloat32(at + i * 4, value, true);
      });
      view.setFloat32(at + 12, heading, true);
      view.setUint16(at + 16, type, true);
      view.setUint16(at + 18, entry, true);
    };
    position(8, [0, -40, 35], Math.PI, 1, 0x1);
    position(28, [0, 0, 114.25], 0, 2, 0x5);
    const parse = BLOCK_PARSERS.get('BSFurnitureMarkerNode');
    const block = parse?.(new BinaryReader(bytes), { strings: ['FRN'], bsVersion: 100 }, '');
    expect(block).toMatchObject({ kind: 'furniture-marker', name: 'FRN' });
    if (block?.kind !== 'furniture-marker') throw new Error('not a furniture marker');
    expect(block.positions[0]).toMatchObject({
      offset: [0, -40, 35],
      animationType: 1,
      entryPoints: 1,
    });
    expect(block.positions[0]?.heading).toBeCloseTo(Math.PI);
    expect(block.positions[1]).toMatchObject({ animationType: 2, entryPoints: 5 });
  });
});
