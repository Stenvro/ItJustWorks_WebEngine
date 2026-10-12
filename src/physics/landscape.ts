// The collision of a cell's landscape: its 33×33 heights as a triangle mesh, split the way
// the landscape is drawn (render/terrain-data.ts), on the ground layer. Platform-independent.

import { CELL_SIZE, LAND_GRID, LAND_SPACING, type LandData } from '../world/land.ts';

/** Vertices (world space, game units) and triangles of a cell's landscape. */
export function landscapeMesh(
  land: LandData,
  cellX: number,
  cellY: number,
): { vertices: Float32Array; indices: Uint32Array } {
  const vertices = new Float32Array(LAND_GRID * LAND_GRID * 3);
  for (let y = 0; y < LAND_GRID; y++) {
    for (let x = 0; x < LAND_GRID; x++) {
      const i = (y * LAND_GRID + x) * 3;
      vertices[i] = cellX * CELL_SIZE + x * LAND_SPACING;
      vertices[i + 1] = cellY * CELL_SIZE + y * LAND_SPACING;
      vertices[i + 2] = land.heights[y * LAND_GRID + x] ?? 0;
    }
  }
  const quads = LAND_GRID - 1;
  const indices = new Uint32Array(quads * quads * 6);
  let i = 0;
  for (let y = 0; y < quads; y++) {
    for (let x = 0; x < quads; x++) {
      const a = y * LAND_GRID + x;
      const b = a + 1;
      const c = a + LAND_GRID;
      const d = c + 1;
      // The same diagonal (south-west to north-east) as the drawn landscape.
      indices.set([a, b, d, a, d, c], i);
      i += 6;
    }
  }
  return { vertices, indices };
}
