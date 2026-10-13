import { describe, expect, it } from 'vitest';
import { FACE_MORPHS } from '../animation/face.ts';
import { faceMorphIndices, packMorphs, toHalf, writeMorphSlots } from './face-morphs.ts';

/** Half-float bits back to a number (for checking). */
function fromHalf(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (mantissa / 1024);
  if (exponent === 31) return sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}

describe('face morphs', () => {
  it('converts floats to half floats', () => {
    expect(toHalf(0)).toBe(0);
    expect(toHalf(1)).toBe(0x3c00);
    expect(toHalf(-2)).toBe(0xc000);
    expect(fromHalf(toHalf(0.123))).toBeCloseTo(0.123, 3);
    expect(fromHalf(toHalf(1e-6))).toBeCloseTo(1e-6, 7);
    expect(toHalf(1e6)).toBe(0x7c00);
  });

  it('packs offsets per morph and vertex', () => {
    const data = packMorphs({
      vertexCount: 2,
      positions: new Float32Array(6),
      triangles: new Uint32Array(0),
      modifiers: [],
      morphs: [
        { name: 'Aah', offsets: Float32Array.of(1, 2, 3, 0, 0, 0) },
        { name: 'BlinkLeft', offsets: Float32Array.of(0, 0, 0, -1, 0.5, 0) },
      ],
    });
    expect(data.names).toEqual(['Aah', 'BlinkLeft']);
    expect(data.deltas.length).toBe(8);
    expect(data.deltas[0]).toBe((0x3c00 | (0x4000 << 16)) >>> 0);
    expect(data.deltas[1]).toBe(0x4200);
    expect(data.deltas[6]).toBe((0xbc00 | (0x3800 << 16)) >>> 0);
  });

  it('writes the active morphs a part has, strongest first when too many', () => {
    const indices = faceMorphIndices(['blinkleft', 'Aah']);
    expect(indices[FACE_MORPHS.indexOf('BlinkLeft')]).toBe(0);
    expect(indices[FACE_MORPHS.indexOf('Aah')]).toBe(1);
    expect(indices[FACE_MORPHS.indexOf('MoodHappy')]).toBe(-1);
    const weights = new Float32Array(FACE_MORPHS.length);
    weights[FACE_MORPHS.indexOf('Aah')] = 0.75;
    weights[FACE_MORPHS.indexOf('MoodHappy')] = 1; // the part lacks it
    const out = new Float32Array(128).fill(9);
    writeMorphSlots(weights, indices, 996, out, 64);
    expect(Array.from(out.subarray(64, 70))).toEqual([1, 996, 0, 0, 1, 0.75]);
    expect(out[63]).toBe(9);
  });
});
