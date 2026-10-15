import { describe, expect, it } from 'vitest';
import { rgbaMipChain } from './mipmaps.ts';

describe('rgbaMipChain', () => {
  it('halves each level down to 1×1, averaging 2×2 pixels', () => {
    // 4×2: left half black, right half white (alpha 255).
    const data = new Uint8Array(4 * 2 * 4);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 4; x++) {
        const value = x < 2 ? 0 : 255;
        data.set([value, value, value, 255], (y * 4 + x) * 4);
      }
    }
    const levels = rgbaMipChain(data, 4, 2);
    expect(levels.map((level) => [level.width, level.height])).toEqual([
      [4, 2],
      [2, 1],
      [1, 1],
    ]);
    expect([...(levels[1]?.data ?? [])]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
    expect([...(levels[2]?.data ?? [])]).toEqual([128, 128, 128, 255]);
    expect(levels[0]?.data).toBe(data);
  });
});
