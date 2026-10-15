// Which distant LOD blocks to draw around the camera: the LOD grid of a worldspace is cut
// into blocks of 4, 8, 16 and 32 cells; near the camera small blocks (more detail), further
// out larger ones. Platform-independent. Layouts: docs/formats/lod.md.

import type { LodSettings } from '../formats/lod/lod.ts';
import { CELL_SIZE } from './land.ts';

export interface LodBlock {
  /** Cells per side: 4, 8, 16 or 32. */
  readonly level: number;
  /** South-west cell of the block. */
  readonly x: number;
  readonly y: number;
}

/**
 * Distances (game units) up to which each block size is used: the engine's
 * fBlockLevel0Distance (level 4), fBlockLevel1Distance (level 8) and fBlockMaximumDistance,
 * with SkyrimPrefs.ini's Ultra values. Level 16 reaches twice as far as level 8.
 */
export interface LodDistances {
  readonly level4: number;
  readonly level8: number;
  readonly level16: number;
  readonly maximum: number;
}

export const DEFAULT_LOD_DISTANCES: LodDistances = {
  level4: 35000,
  level8: 70000,
  level16: 140000,
  maximum: 250000,
};

/** fTreeLoadDistance (Ultra): tree LOD is drawn up to here. */
export const TREE_LOD_DISTANCE = 75000;

export const lodBlockKey = (block: LodBlock): string =>
  `${String(block.level)}.${String(block.x)}.${String(block.y)}`;

/** Distance from a point to the nearest point of a block (horizontal). */
export function blockDistance(block: LodBlock, x: number, y: number): number {
  const minX = block.x * CELL_SIZE;
  const minY = block.y * CELL_SIZE;
  const size = block.level * CELL_SIZE;
  const dx = Math.max(minX - x, 0, x - (minX + size));
  const dy = Math.max(minY - y, 0, y - (minY + size));
  return Math.hypot(dx, dy);
}

/** The blocks of the largest size are split into four while they are close enough. */
export function selectLodBlocks(
  settings: LodSettings,
  x: number,
  y: number,
  distances: LodDistances = DEFAULT_LOD_DISTANCES,
): LodBlock[] {
  const blocks: LodBlock[] = [];
  const splitBelow = (level: number): number =>
    level <= 8 ? distances.level4 : level <= 16 ? distances.level8 : distances.level16;
  const visit = (block: LodBlock): void => {
    const distance = blockDistance(block, x, y);
    if (distance > distances.maximum) return;
    if (block.level > settings.lowestLevel && distance < splitBelow(block.level)) {
      const half = block.level / 2;
      for (const [dx, dy] of [
        [0, 0],
        [half, 0],
        [0, half],
        [half, half],
      ] as const) {
        visit({ level: half, x: block.x + dx, y: block.y + dy });
      }
      return;
    }
    blocks.push(block);
  };
  const top = settings.highestLevel;
  for (let by = settings.southWestY; by < settings.southWestY + settings.stride; by += top) {
    for (let bx = settings.southWestX; bx < settings.southWestX + settings.stride; bx += top) {
      visit({ level: top, x: bx, y: by });
    }
  }
  return blocks;
}

/** The blocks of a level inside a larger block (or the block itself if it is that level). */
export function blocksOfLevel(block: LodBlock, level: number): LodBlock[] {
  if (block.level <= level) return [block];
  const out: LodBlock[] = [];
  for (let dy = 0; dy < block.level; dy += level) {
    for (let dx = 0; dx < block.level; dx += level) {
      out.push({ level, x: block.x + dx, y: block.y + dy });
    }
  }
  return out;
}

/** Whether two blocks cover any cell in common. */
export function blocksOverlap(a: LodBlock, b: LodBlock): boolean {
  return a.x < b.x + b.level && b.x < a.x + a.level && a.y < b.y + b.level && b.y < a.y + a.level;
}

/** Every block of one size over the whole LOD grid (the world map's locked LOD). */
export function allLodBlocks(settings: LodSettings, level: number): LodBlock[] {
  const blocks: LodBlock[] = [];
  const end = (start: number): number => start + settings.stride;
  for (let y = settings.southWestY; y < end(settings.southWestY); y += level) {
    for (let x = settings.southWestX; x < end(settings.southWestX); x += level) {
      blocks.push({ level, x, y });
    }
  }
  return blocks;
}
