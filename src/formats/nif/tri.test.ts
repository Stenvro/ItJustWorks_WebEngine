import { describe, expect, it } from 'vitest';
import { FormatError } from '../binary-reader.ts';
import { parseTri } from './tri.ts';

/** A TRI file: 3 vertices, 1 triangle, a morph and a modifier on vertex 2. */
function tri(): Uint8Array {
  const bytes: number[] = [];
  const view = new DataView(new ArrayBuffer(4));
  const i32 = (...values: number[]): void => {
    for (const value of values) {
      view.setInt32(0, value, true);
      bytes.push(...new Uint8Array(view.buffer));
    }
  };
  const f32 = (...values: number[]): void => {
    for (const value of values) {
      view.setFloat32(0, value, true);
      bytes.push(...new Uint8Array(view.buffer));
    }
  };
  const i16 = (...values: number[]): void => {
    for (const value of values) bytes.push(value & 0xff, (value >> 8) & 0xff);
  };
  const text = (value: string): void => {
    i32(value.length + 1);
    for (const char of value) bytes.push(char.charCodeAt(0));
    bytes.push(0);
  };
  for (const char of 'FRTRI003') bytes.push(char.charCodeAt(0));
  // vertices, triangles, quads, 2 unknown, uvs, has uv, morphs, modifiers, modifier vertices,
  // 4 unknown
  i32(3, 1, 0, 0, 0, 3, 1, 1, 1, 1, 0, 0, 0, 0);
  f32(0, 0, 0, 1, 0, 0, 0, 1, 0); // vertices
  f32(5, 5, 5); // modifier vertex
  i32(0, 1, 2); // triangle
  f32(0, 0, 1, 0, 0, 1); // uvs
  i32(0, 1, 2); // uv triangle
  text('BlinkLeft');
  f32(0.5);
  i16(0, 0, 0, 2, 0, 0, 0, -4, 0);
  text('Lid');
  i32(1, 2);
  return Uint8Array.from(bytes);
}

describe('FaceGen TRI files', () => {
  it('reads the base mesh, morphs (offsets times scale) and modifiers', () => {
    const file = parseTri(tri());
    expect(file.vertexCount).toBe(3);
    expect(Array.from(file.triangles)).toEqual([0, 1, 2]);
    expect(Array.from(file.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(file.morphs.map((morph) => morph.name)).toEqual(['BlinkLeft']);
    expect(Array.from(file.morphs[0]?.offsets ?? [])).toEqual([0, 0, 0, 1, 0, 0, 0, -2, 0]);
    expect(file.modifiers).toEqual([
      { name: 'Lid', vertices: Uint32Array.of(2), positions: Float32Array.of(5, 5, 5) },
    ]);
  });

  it('rejects other files', () => {
    expect(() => parseTri(new Uint8Array(64))).toThrow(FormatError);
  });
});
