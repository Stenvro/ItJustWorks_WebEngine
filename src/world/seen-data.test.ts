import { describe, expect, it } from 'vitest';
import { markSeen, seenAt, seenRaster, type SeenBlocks } from './seen-data.ts';

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
});
