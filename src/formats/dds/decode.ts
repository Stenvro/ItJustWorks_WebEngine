// CPU decoding of DDS levels to RGBA8, for the few textures the engine reads pixel by pixel
// (face tint masks, the baked face tints they are checked against). BC1 and BC3 follow the
// Direct3D block compression rules (docs/formats/dds.md); everything else stays on the GPU.

import { FormatError } from '../binary-reader.ts';
import type { DdsLevel, DdsTexture } from './dds.ts';

/** RGB565 → bytes. */
function rgb565(value: number): [number, number, number] {
  const r = (value >>> 11) & 31;
  const g = (value >>> 5) & 63;
  const b = value & 31;
  return [(r * 255) / 31, (g * 255) / 63, (b * 255) / 31];
}

/** One BC1 colour block into `out` (RGBA8, `width` pixels per row) at block (bx, by). */
function decodeColorBlock(
  data: Uint8Array,
  at: number,
  out: Uint8Array,
  width: number,
  height: number,
  bx: number,
  by: number,
  punchThrough: boolean,
): void {
  const c0 = (data[at] ?? 0) | ((data[at + 1] ?? 0) << 8);
  const c1 = (data[at + 2] ?? 0) | ((data[at + 3] ?? 0) << 8);
  const p0 = rgb565(c0);
  const p1 = rgb565(c1);
  const palette: [number, number, number, number][] = [
    [...p0, 255],
    [...p1, 255],
  ];
  if (c0 > c1 || !punchThrough) {
    palette.push(
      [(2 * p0[0] + p1[0]) / 3, (2 * p0[1] + p1[1]) / 3, (2 * p0[2] + p1[2]) / 3, 255],
      [(p0[0] + 2 * p1[0]) / 3, (p0[1] + 2 * p1[1]) / 3, (p0[2] + 2 * p1[2]) / 3, 255],
    );
  } else {
    palette.push(
      [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2, 255],
      [0, 0, 0, 0],
    );
  }
  const bits =
    ((data[at + 4] ?? 0) |
      ((data[at + 5] ?? 0) << 8) |
      ((data[at + 6] ?? 0) << 16) |
      ((data[at + 7] ?? 0) << 24)) >>>
    0;
  for (let i = 0; i < 16; i++) {
    const x = bx * 4 + (i & 3);
    const y = by * 4 + (i >>> 2);
    if (x >= width || y >= height) continue;
    const color = palette[(bits >>> (2 * i)) & 3] ?? [0, 0, 0, 0];
    const o = (y * width + x) * 4;
    out[o] = Math.round(color[0]);
    out[o + 1] = Math.round(color[1]);
    out[o + 2] = Math.round(color[2]);
    out[o + 3] = color[3];
  }
}

/** One BC3 alpha block (two endpoints, 3-bit indices) into the alpha bytes of `out`. */
function decodeAlphaBlock(
  data: Uint8Array,
  at: number,
  out: Uint8Array,
  width: number,
  height: number,
  bx: number,
  by: number,
): void {
  const a0 = data[at] ?? 0;
  const a1 = data[at + 1] ?? 0;
  const alphas = [a0, a1];
  if (a0 > a1) {
    for (let i = 1; i < 7; i++) alphas.push(((7 - i) * a0 + i * a1) / 7);
  } else {
    for (let i = 1; i < 5; i++) alphas.push(((5 - i) * a0 + i * a1) / 5);
    alphas.push(0, 255);
  }
  // 48 index bits: two 24-bit halves keep the arithmetic in 32-bit range.
  for (let half = 0; half < 2; half++) {
    const base = at + 2 + half * 3;
    const bits = (data[base] ?? 0) | ((data[base + 1] ?? 0) << 8) | ((data[base + 2] ?? 0) << 16);
    for (let j = 0; j < 8; j++) {
      const i = half * 8 + j;
      const x = bx * 4 + (i & 3);
      const y = by * 4 + (i >>> 2);
      if (x >= width || y >= height) continue;
      out[(y * width + x) * 4 + 3] = Math.round(alphas[(bits >>> (3 * j)) & 7] ?? 0);
    }
  }
}

/**
 * A level of a texture as RGBA8 pixels (`width × height × 4` bytes). Supports BC1, BC3 and
 * the uncompressed 8-bit layouts; throws a FormatError for other formats.
 */
export function decodeDdsLevel(texture: DdsTexture, level: DdsLevel): Uint8Array {
  const { width, height } = level;
  const data = texture.data.subarray(level.offset, level.offset + level.size);
  const out = new Uint8Array(width * height * 4);
  const blocksX = Math.max(1, Math.ceil(width / 4));
  const blocksY = Math.max(1, Math.ceil(height / 4));
  switch (texture.format) {
    case 'rgba8unorm':
      out.set(data.subarray(0, out.length));
      return out;
    case 'bgra8unorm':
      for (let i = 0; i < width * height; i++) {
        out[i * 4] = data[i * 4 + 2] ?? 0;
        out[i * 4 + 1] = data[i * 4 + 1] ?? 0;
        out[i * 4 + 2] = data[i * 4] ?? 0;
        out[i * 4 + 3] = data[i * 4 + 3] ?? 0;
      }
      return out;
    case 'r8unorm':
      for (let i = 0; i < width * height; i++) {
        const value = data[i] ?? 0;
        out.set([value, value, value, 255], i * 4);
      }
      return out;
    case 'bc1-rgba-unorm':
      for (let by = 0; by < blocksY; by++)
        for (let bx = 0; bx < blocksX; bx++)
          decodeColorBlock(data, (by * blocksX + bx) * 8, out, width, height, bx, by, true);
      return out;
    case 'bc3-rgba-unorm':
      for (let by = 0; by < blocksY; by++)
        for (let bx = 0; bx < blocksX; bx++) {
          const at = (by * blocksX + bx) * 16;
          decodeColorBlock(data, at + 8, out, width, height, bx, by, false);
          decodeAlphaBlock(data, at, out, width, height, bx, by);
        }
      return out;
    default:
      throw new FormatError(`No CPU decoder for ${texture.format}`, 0);
  }
}
