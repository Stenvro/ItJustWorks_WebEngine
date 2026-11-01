import { describe, expect, it } from 'vitest';
import { markSeen, seenAt, seenFromSave, seenRaster, type SeenBlocks } from './seen-data.ts';

describe('seen data', () => {
  it('marks the squares near the player, across blocks', () => {
    const blocks: SeenBlocks = new Map();
    expect(markSeen(blocks, 4096, 0, 300)).toBe(true);
    expect(markSeen(blocks, 4096, 0, 300)).toBe(false);
    expect(seenAt(blocks, 4000, 10)).toBe(true);
    expect(seenAt(blocks, 4200, -10)).toBe(true);
    expect(seenAt(blocks, 5000, 0)).toBe(false);
    expect(blocks.size).toBe(4);
  });

  it('rasters an area, rows from the south', () => {
    const blocks: SeenBlocks = new Map();
    markSeen(blocks, 64, 64, 10);
    const raster = seenRaster(blocks, [0, 0], [256, 256]);
    expect(raster.width).toBe(2);
    expect(raster.height).toBe(2);
    expect([...raster.data]).toEqual([255, 0, 0, 0]);
    expect(raster.origin).toEqual([0, 0]);
  });

  it("takes an original save's 16 x 16 block as 2 x 2 squares of ours each", () => {
    const saved = new Uint8Array(32);
    saved[0] = 0b1; // the first square of the first row
    saved[31] = 0x80; // the last square of the last row
    const blocks: SeenBlocks = new Map([['0,0', seenFromSave(saved)]]);
    for (const [x, y] of [
      [10, 10],
      [200, 200],
      [4090, 4090],
      [3900, 3900],
    ] as const) {
      expect(seenAt(blocks, x, y)).toBe(true);
    }
    expect(seenAt(blocks, 300, 10)).toBe(false);
    expect(seenAt(blocks, 10, 300)).toBe(false);
  });
});
