// FaceGen TRI files (FRTRI003): a head part's morphs. A head part (HDPT) names its expression
// morphs as a "Tri" part: one morph per phoneme, blink, look direction and mood ("Aah",
// "BlinkLeft", "LookDown", "MoodHappy", ...), each a 16-bit offset per vertex times a scale;
// modifiers move a few vertices to absolute places. Layout: pyffi's tri.xml; notes in
// docs/formats/nif.md ("TRI"). Platform-independent.

import { BinaryReader, FormatError } from '../binary-reader.ts';

export interface TriMorph {
  readonly name: string;
  /** Per vertex: x, y, z offsets, already times the morph's scale. */
  readonly offsets: Float32Array;
}

export interface TriModifier {
  readonly name: string;
  readonly vertices: Uint32Array;
  /** Per modified vertex: its x, y, z. */
  readonly positions: Float32Array;
}

export interface TriFile {
  readonly vertexCount: number;
  /** The base mesh's positions (x, y, z per vertex). */
  readonly positions: Float32Array;
  readonly triangles: Uint32Array;
  readonly morphs: readonly TriMorph[];
  readonly modifiers: readonly TriModifier[];
}

const MAGIC = 'FRTRI003';
/** Counts beyond any vanilla file: a sign of a broken one. */
const MAX_COUNT = 1 << 22;

export function parseTri(bytes: Uint8Array): TriFile {
  const reader = new BinaryReader(bytes);
  const magic = String.fromCharCode(...reader.bytes(8));
  if (magic !== MAGIC) throw new FormatError(`Not a FaceGen TRI file (${magic})`, 0);
  const count = (): number => {
    const value = reader.i32();
    if (value < 0 || value > MAX_COUNT)
      throw new FormatError(`TRI count ${String(value)}`, reader.offset - 4);
    return value;
  };
  const vertexCount = count();
  const triangleCount = count();
  const quadCount = count();
  reader.skip(8); // unknown 1, 2
  const uvCount = count();
  const hasUv = reader.i32() !== 0;
  const morphCount = count();
  const modifierCount = count();
  const modifierVertexCount = count();
  reader.skip(16); // unknown 3..6

  const floats = (length: number): Float32Array =>
    Float32Array.from({ length }, () => reader.f32());
  const positions = floats(vertexCount * 3);
  const modifierPositions = floats(modifierVertexCount * 3);
  const triangles = new Uint32Array(triangleCount * 3);
  for (let i = 0; i < triangles.length; i++) triangles[i] = reader.u32();
  reader.skip(quadCount * 16 + uvCount * 8);
  if (hasUv) reader.skip(triangleCount * 12 + quadCount * 16);

  const name = (): string => {
    const length = reader.u32();
    if (length > 4096)
      throw new FormatError(`TRI name of ${String(length)} bytes`, reader.offset - 4);
    const text = String.fromCharCode(...reader.bytes(length));
    const end = text.indexOf('\0');
    return end < 0 ? text : text.slice(0, end);
  };
  const morphs: TriMorph[] = [];
  for (let m = 0; m < morphCount; m++) {
    const morphName = name();
    const scale = reader.f32();
    const offsets = new Float32Array(vertexCount * 3);
    for (let i = 0; i < offsets.length; i++) offsets[i] = reader.i16() * scale;
    morphs.push({ name: morphName, offsets });
  }
  const modifiers: TriModifier[] = [];
  let used = 0;
  for (let m = 0; m < modifierCount; m++) {
    const modifierName = name();
    const length = count();
    const vertices = new Uint32Array(length);
    for (let i = 0; i < length; i++) vertices[i] = reader.u32();
    modifiers.push({
      name: modifierName,
      vertices,
      positions: modifierPositions.slice(used * 3, (used + length) * 3),
    });
    used += length;
  }
  return { vertexCount, positions, triangles, morphs, modifiers };
}
