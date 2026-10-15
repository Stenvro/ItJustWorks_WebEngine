// What the player has seen of an interior: the local map's fog of war. Inside, the local map
// shows only what the player has come near; the rest stays dark (the game draws its fog over
// the local map's picture: LOCALMAP_FOGOFWAR, which ISLocalMap reads as unseen). The game keeps
// it per cell (a save's CELL change form, CHANGE_CELL_SEENDATA); its layout is not documented.
// Kept here as the engine family's SEEN_DATA: a 32 × 32 grid of bits for each 4096-unit block
// of the cell (128 units a square). How near is seen is not documented either: SEEN_RADIUS is
// fitted. TODO(M13): the game's radius. TODO(M12): in the save. Platform-independent.
// Notes: docs/ui.md ("The local map").

/** A block's side (world units) and its squares a side. */
export const SEEN_BLOCK = 4096;
export const SEEN_GRID = 32;
const SQUARE = SEEN_BLOCK / SEEN_GRID;
/** How near the player a square counts as seen (world units; fitted, see above). */
export const SEEN_RADIUS = 1024;

/** A cell's seen squares: a bit grid per block ("x,y" of the block). */
export type SeenBlocks = Map<string, Uint8Array>;

const blockKey = (bx: number, by: number): string => `${String(bx)},${String(by)}`;

/** Marks the squares within `radius` of a point as seen; whether any was new. */
export function markSeen(blocks: SeenBlocks, x: number, y: number, radius = SEEN_RADIUS): boolean {
  let changed = false;
  const first = (value: number): number => Math.floor((value - radius) / SQUARE);
  const last = (value: number): number => Math.floor((value + radius) / SQUARE);
  for (let sy = first(y); sy <= last(y); sy++) {
    for (let sx = first(x); sx <= last(x); sx++) {
      const cx = (sx + 0.5) * SQUARE;
      const cy = (sy + 0.5) * SQUARE;
      if (Math.hypot(cx - x, cy - y) > radius) continue;
      const bx = Math.floor(sx / SEEN_GRID);
      const by = Math.floor(sy / SEEN_GRID);
      let bits = blocks.get(blockKey(bx, by));
      if (!bits) {
        bits = new Uint8Array((SEEN_GRID * SEEN_GRID) / 8);
        blocks.set(blockKey(bx, by), bits);
      }
      const bit = (sy - by * SEEN_GRID) * SEEN_GRID + (sx - bx * SEEN_GRID);
      const mask = 1 << (bit & 7);
      if (((bits[bit >> 3] ?? 0) & mask) === 0) {
        bits[bit >> 3] = (bits[bit >> 3] ?? 0) | mask;
        changed = true;
      }
    }
  }
  return changed;
}

/** Whether the square holding a point has been seen. */
export function seenAt(blocks: SeenBlocks, x: number, y: number): boolean {
  const sx = Math.floor(x / SQUARE);
  const sy = Math.floor(y / SQUARE);
  const bx = Math.floor(sx / SEEN_GRID);
  const by = Math.floor(sy / SEEN_GRID);
  const bits = blocks.get(blockKey(bx, by));
  if (!bits) return false;
  const bit = (sy - by * SEEN_GRID) * SEEN_GRID + (sx - bx * SEEN_GRID);
  return ((bits[bit >> 3] ?? 0) & (1 << (bit & 7))) !== 0;
}

/** The seen squares over an area, one byte a square (255 seen, 0 not), rows south to north. */
export interface SeenRaster {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** The south-west corner of the first square (world units) and a square's side. */
  readonly origin: readonly [number, number];
  readonly square: number;
}

export function seenRaster(
  blocks: SeenBlocks,
  min: readonly [number, number],
  max: readonly [number, number],
): SeenRaster {
  const x0 = Math.floor(min[0] / SQUARE);
  const y0 = Math.floor(min[1] / SQUARE);
  const width = Math.max(1, Math.ceil(max[0] / SQUARE) - x0);
  const height = Math.max(1, Math.ceil(max[1] / SQUARE) - y0);
  const data = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const x = (x0 + column + 0.5) * SQUARE;
      const y = (y0 + row + 0.5) * SQUARE;
      data[row * width + column] = seenAt(blocks, x, y) ? 255 : 0;
    }
  }
  return { data, width, height, origin: [x0 * SQUARE, y0 * SQUARE], square: SQUARE };
}
