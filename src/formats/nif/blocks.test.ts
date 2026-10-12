import { describe, expect, it } from 'vitest';
import { decodeVertexDesc, VertexAttribute } from './blocks.ts';

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
