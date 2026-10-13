// Bone palettes of skinned draws: per bone the matrix that takes a vertex from skin space to
// model space in the current pose (the bone's model-space matrix times its bind transform),
// as the three rows of an affine matrix, the layout the skinned vertex stage reads
// (shaders/skinning.wgsl).

import { fromHalf, type PartSkin } from './skinning.ts';

/** Floats per bone: three rows of four. */
export const PALETTE_BONE_FLOATS = 12;
/** Vertices name their bones with one byte. */
export const MAX_PALETTE_BONES = 256;

/**
 * Writes one bone's rows into `out` at `at`: `world` (column-major 4x4 at `worldAt`) times
 * `bind` (column-major 4x4 at `bindAt`).
 */
export function writePaletteBone(
  out: Float32Array,
  at: number,
  world: ArrayLike<number>,
  worldAt: number,
  bind: ArrayLike<number>,
  bindAt: number,
): void {
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += (world[worldAt + k * 4 + row] ?? 0) * (bind[bindAt + col * 4 + k] ?? 0);
      }
      out[at + row * 4 + col] = sum;
    }
  }
}

/** A skin's palette in its rest pose (the bones as the file places them). */
export function writeRestPalette(skin: PartSkin, out: Float32Array, at = 0): void {
  for (let i = 0; i < skin.bones.length; i++) {
    writePaletteBone(out, at + i * PALETTE_BONE_FLOATS, skin.rest, i * 16, skin.bind, i * 16);
  }
}

/**
 * A skin's palette in a pose: `boneWorld(i)` gives bone i's model-space matrix (column-major,
 * 16 floats) or undefined to keep its rest matrix.
 */
export function writePosedPalette(
  skin: PartSkin,
  boneWorld: (bone: number) => ArrayLike<number> | undefined,
  out: Float32Array,
  at = 0,
): void {
  for (let i = 0; i < skin.bones.length; i++) {
    const world = boneWorld(i);
    writePaletteBone(
      out,
      at + i * PALETTE_BONE_FLOATS,
      world ?? skin.rest,
      world ? 0 : i * 16,
      skin.bind,
      i * 16,
    );
  }
}

/**
 * The vertices' positions as the skinned vertex stage places them with a palette (CPU, for
 * rays and tests): xyz per vertex. Vertices: `stride` bytes each, position f32x3 at 0, four
 * half-float weights and four bone indices at `skinning`.
 */
export function skinPositions(
  vertices: Uint8Array,
  stride: number,
  skinning: number,
  vertexCount: number,
  palette: Float32Array,
): Float32Array {
  const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
  const out = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    const base = v * stride;
    const p = [
      view.getFloat32(base, true),
      view.getFloat32(base + 4, true),
      view.getFloat32(base + 8, true),
      1,
    ];
    let total = 0;
    for (let k = 0; k < 4; k++) {
      const weight = fromHalf(view.getUint16(base + skinning + k * 2, true));
      if (!(weight > 0)) continue;
      const bone = view.getUint8(base + skinning + 8 + k) * PALETTE_BONE_FLOATS;
      for (let row = 0; row < 3; row++) {
        let sum = 0;
        for (let c = 0; c < 4; c++) sum += (palette[bone + row * 4 + c] ?? 0) * (p[c] ?? 0);
        out[v * 3 + row] = (out[v * 3 + row] ?? 0) + sum * weight;
      }
      total += weight;
    }
    if (total > 0) {
      for (let row = 0; row < 3; row++) out[v * 3 + row] = (out[v * 3 + row] ?? 0) / total;
    } else {
      for (let row = 0; row < 3; row++) {
        let sum = 0;
        for (let c = 0; c < 4; c++) sum += (palette[row * 4 + c] ?? 0) * (p[c] ?? 0);
        out[v * 3 + row] = sum;
      }
    }
  }
  return out;
}
