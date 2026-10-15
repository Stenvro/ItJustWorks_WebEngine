import { describe, expect, it } from 'vitest';
import { FormatError } from '../binary-reader.ts';
import type { DdsFormat, DdsTexture } from './dds.ts';
import { decodeDdsLevel } from './decode.ts';

const texture = (format: DdsFormat, width: number, height: number, data: Uint8Array) => {
  const tex: DdsTexture = {
    format,
    srgb: false,
    width,
    height,
    mipCount: 1,
    layerCount: 1,
    cubemap: false,
    levels: [
      {
        layer: 0,
        mip: 0,
        width,
        height,
        offset: 0,
        size: data.length,
        bytesPerRow: 0,
        rows: 0,
      },
    ],
    data,
  };
  const [level] = tex.levels;
  if (!level) throw new Error('no level');
  return decodeDdsLevel(tex, level);
};

/** A BC1 colour block: endpoints (RGB565) and 2-bit indices. */
const colorBlock = (c0: number, c1: number, indices: number[]): number[] => {
  let bits = 0;
  indices.forEach((index, i) => (bits |= index << (2 * i)));
  return [
    c0 & 0xff,
    c0 >>> 8,
    c1 & 0xff,
    c1 >>> 8,
    bits & 0xff,
    (bits >>> 8) & 0xff,
    (bits >>> 16) & 0xff,
    bits >>> 24,
  ];
};

describe('DDS CPU decoding', () => {
  it('decodes BC1 with its four-colour and punch-through palettes', () => {
    // White (0xffff) and black (0): pixel i picks index i % 4.
    const indices = Array.from({ length: 16 }, (_, i) => i % 4);
    const four = texture('bc1-rgba-unorm', 4, 4, Uint8Array.from(colorBlock(0xffff, 0, indices)));
    expect([...four.subarray(0, 16)]).toEqual([
      255, 255, 255, 255, 0, 0, 0, 255, 170, 170, 170, 255, 85, 85, 85, 255,
    ]);
    const punch = texture('bc1-rgba-unorm', 4, 4, Uint8Array.from(colorBlock(0, 0xffff, indices)));
    expect([...punch.subarray(8, 16)]).toEqual([128, 128, 128, 255, 0, 0, 0, 0]);
  });

  it('decodes BC3 alpha (8-step and 6-step ramps) and clips to the image size', () => {
    // Alpha 255 → 0 with 3-bit indices 0..7 for the first 8 pixels, then 1.
    const indices = [0, 1, 2, 3, 4, 5, 6, 7, 1, 1, 1, 1, 1, 1, 1, 1];
    let low = 0;
    let high = 0;
    indices.forEach((index, i) => {
      if (i < 8) low |= index << (3 * i);
      else high |= index << (3 * (i - 8));
    });
    const alpha = [
      255,
      0,
      low & 0xff,
      (low >>> 8) & 0xff,
      low >>> 16,
      high & 0xff,
      (high >>> 8) & 0xff,
      high >>> 16,
    ];
    const block = Uint8Array.from([
      ...alpha,
      ...colorBlock(0xf800, 0xf800, new Array<number>(16).fill(0)),
    ]);
    const out = texture('bc3-rgba-unorm', 3, 3, block);
    expect(out.length).toBe(36);
    expect([...out.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    // Row 0: indices 0, 1, 2 → 255, 0, 255·6/7; row 1 starts with block pixel 4 (index 4).
    expect([out[3], out[7], out[11], out[15]]).toEqual([255, 0, 219, 146]);
  });

  it('swizzles BGRA and expands R8', () => {
    expect([...texture('bgra8unorm', 1, 1, Uint8Array.of(1, 2, 3, 4))]).toEqual([3, 2, 1, 4]);
    expect([...texture('r8unorm', 1, 1, Uint8Array.of(9))]).toEqual([9, 9, 9, 255]);
  });

  it('refuses formats it cannot decode', () => {
    expect(() => texture('bc7-rgba-unorm', 4, 4, new Uint8Array(16))).toThrow(FormatError);
  });
});
