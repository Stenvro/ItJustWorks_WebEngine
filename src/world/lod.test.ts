import { describe, expect, it } from 'vitest';
import type { LodSettings } from '../formats/lod/lod.ts';
import { CELL_SIZE } from './land.ts';
import {
  blockDistance,
  blocksOfLevel,
  blocksOverlap,
  DEFAULT_LOD_DISTANCES,
  selectLodBlocks,
} from './lod.ts';

const tamriel: LodSettings = {
  southWestX: -96,
  southWestY: -96,
  stride: 256,
  lowestLevel: 4,
  highestLevel: 32,
};

describe('selectLodBlocks', () => {
  const camera: [number, number] = [4.5 * CELL_SIZE, -2.5 * CELL_SIZE];
  const blocks = selectLodBlocks(tamriel, ...camera);

  it('uses small blocks near the camera and large ones far away', () => {
    const near = blocks.filter((b) => blockDistance(b, ...camera) === 0);
    expect(near).toEqual([{ level: 4, x: 4, y: -4 }]);
    for (const block of blocks) {
      const distance = blockDistance(block, ...camera);
      if (block.level === 32)
        expect(distance).toBeGreaterThanOrEqual(DEFAULT_LOD_DISTANCES.level16);
      // A split block's far children may lie beyond the distance its near edge was within.
      if (block.level === 4) {
        expect(distance).toBeLessThan(DEFAULT_LOD_DISTANCES.level4 + 8 * CELL_SIZE * Math.SQRT2);
      }
      expect(distance).toBeLessThanOrEqual(DEFAULT_LOD_DISTANCES.maximum);
    }
    expect(new Set(blocks.map((b) => b.level))).toEqual(new Set([4, 8, 16, 32]));
  });

  it('covers every cell within reach exactly once, aligned to the grid', () => {
    for (const a of blocks) {
      expect((a.x - tamriel.southWestX) % a.level).toBe(0);
      expect((a.y - tamriel.southWestY) % a.level).toBe(0);
      for (const b of blocks) if (a !== b) expect(blocksOverlap(a, b)).toBe(false);
    }
    const cells = blocks.reduce((sum, b) => sum + b.level * b.level, 0);
    // A disc of the maximum distance, give or take the blocks on its edge.
    const disc = Math.PI * (DEFAULT_LOD_DISTANCES.maximum / CELL_SIZE) ** 2;
    expect(cells).toBeGreaterThan(disc * 0.8);
    expect(cells).toBeLessThan(disc * 1.6);
  });
});

describe('blocks', () => {
  it('splits a block into blocks of a smaller level', () => {
    expect(blocksOfLevel({ level: 32, x: 0, y: 0 }, 16)).toEqual([
      { level: 16, x: 0, y: 0 },
      { level: 16, x: 16, y: 0 },
      { level: 16, x: 0, y: 16 },
      { level: 16, x: 16, y: 16 },
    ]);
    expect(blocksOfLevel({ level: 8, x: 4, y: 4 }, 16)).toEqual([{ level: 8, x: 4, y: 4 }]);
  });

  it('measures the distance to the nearest edge', () => {
    const block = { level: 4, x: 0, y: 0 };
    expect(blockDistance(block, 100, 100)).toBe(0);
    expect(blockDistance(block, -100, 0)).toBe(100);
    expect(blockDistance(block, 4 * CELL_SIZE + 3, 4 * CELL_SIZE + 4)).toBe(5);
  });
});
