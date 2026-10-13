// Expression morphs of FaceGen head parts on the GPU: a head part's TRI file (phonemes,
// blinks, looks, moods; src/formats/nif/tri.ts) packed as half-float offsets per vertex, one
// buffer per TRI file shared by every head that uses it. A draw lists its active morphs
// (index and weight, up to MAX_ACTIVE_MORPHS) in a small region of its scene's bone buffer;
// the skinned vertex stage adds their offsets before skinning (skinning.wgsl). The game
// morphs BSDynamicTriShape positions on the CPU per actor; on the GPU the shapes stay shared.
// Platform-independent (packing); the buffers are made by the scene renderer.

import { FACE_MORPHS } from '../animation/face.ts';
import type { TriFile } from '../formats/nif/tri.ts';

/** A TRI file's morphs, packed: per morph and vertex two u32 (x|y and z as half floats). */
export interface MorphData {
  readonly vertexCount: number;
  /** The TRI morph names, in file order. */
  readonly names: readonly string[];
  readonly deltas: Uint32Array;
}

/** Active morphs per draw: the region (256 bytes) holds a header and two per vec4. */
export const MAX_ACTIVE_MORPHS = 30;
/** Bytes of a draw's morph region (header vec4 + MAX_ACTIVE_MORPHS / 2 vec4). */
export const MORPH_REGION_BYTES = 256;

/** A float as IEEE half-precision bits (round to nearest; overflow to ±infinity). */
export function toHalf(value: number): number {
  const f32 = new Float32Array([value]);
  const bits = new Uint32Array(f32.buffer)[0] ?? 0;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const mantissa = bits & 0x7fffff;
  if (exponent >= 31) return sign | 0x7c00;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    const m = (mantissa | 0x800000) >>> (1 - exponent);
    return sign | ((m + 0x1000) >>> 13);
  }
  const rounded = (exponent << 10) + ((mantissa + 0x1000) >>> 13);
  return sign | Math.min(rounded, 0x7c00);
}

/** Packs a TRI file's morph offsets for the GPU. */
export function packMorphs(tri: TriFile): MorphData {
  const count = tri.vertexCount;
  const deltas = new Uint32Array(tri.morphs.length * count * 2);
  tri.morphs.forEach((morph, m) => {
    for (let v = 0; v < count; v++) {
      const x = toHalf(morph.offsets[v * 3] ?? 0);
      const y = toHalf(morph.offsets[v * 3 + 1] ?? 0);
      const z = toHalf(morph.offsets[v * 3 + 2] ?? 0);
      const at = (m * count + v) * 2;
      deltas[at] = (x | (y << 16)) >>> 0;
      deltas[at + 1] = z;
    }
  });
  return { vertexCount: count, names: tri.morphs.map((morph) => morph.name), deltas };
}

/** For each face morph (FACE_MORPHS order), its index in a TRI file's morphs (−1: none). */
export function faceMorphIndices(names: readonly string[]): Int16Array {
  const byName = new Map(names.map((name, i) => [name.toLowerCase(), i]));
  return Int16Array.from(FACE_MORPHS, (name) => byName.get(name.toLowerCase()) ?? -1);
}

/**
 * Writes a draw's active morphs into its region (`at`: float index): the header (count,
 * vertex count), then (morph index, weight) pairs, the strongest first when more are active
 * than fit.
 */
export function writeMorphSlots(
  weights: Float32Array,
  indices: Int16Array,
  vertexCount: number,
  out: Float32Array,
  at: number,
): void {
  const active: { index: number; weight: number }[] = [];
  for (let i = 0; i < weights.length; i++) {
    const weight = weights[i] ?? 0;
    const index = indices[i] ?? -1;
    if (index >= 0 && Math.abs(weight) > 1 / 512) active.push({ index, weight });
  }
  if (active.length > MAX_ACTIVE_MORPHS) {
    active.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
    active.length = MAX_ACTIVE_MORPHS;
  }
  out.fill(0, at, at + MORPH_REGION_BYTES / 4);
  out[at] = active.length;
  out[at + 1] = vertexCount;
  active.forEach(({ index, weight }, k) => {
    out[at + 4 + k * 2] = index;
    out[at + 5 + k * 2] = weight;
  });
}
