// Where an actor uses a furniture from: its model's markers (BSFurnitureMarkerNode, "FRN":
// an offset and a heading each, sit / sleep / lean), of which the furniture (FURN MNAM, the
// low 24 bits) makes some active. Platform-independent.
// Notes: docs/formats/nif.md ("Furniture markers"), docs/ai.md.

import type { NifFile } from '../formats/nif/nif.ts';
import type { FurniturePosition } from '../formats/nif/types.ts';

/** FURN MNAM: the bits of the markers that are active (one per marker, from the first). */
const ACTIVE_MARKERS = 0x00ffffff;

/** The furniture markers of a model (its BSFurnitureMarkerNode / BSFurnitureMarker). */
export function furnitureMarkers(nif: NifFile): FurniturePosition[] {
  for (const block of nif.blocks) {
    if (block.kind === 'furniture-marker') return [...block.positions];
  }
  return [];
}

/** The first marker the furniture makes active (MNAM; without one, the first marker). */
export function activeMarker(
  markers: readonly FurniturePosition[],
  flags: number | undefined,
): FurniturePosition | undefined {
  if (flags === undefined) return markers[0];
  const active = flags & ACTIVE_MARKERS;
  return markers.find((_, i) => i < 24 && (active & (1 << i)) !== 0);
}

/**
 * A marker's place on a placed furniture: its offset turned with the furniture (about z) and
 * its heading added. `height` keeps the marker's own height above the furniture's origin.
 */
export function markerPlacement(
  furniture: { readonly position: readonly number[]; readonly rotation: readonly number[] },
  marker: FurniturePosition,
  height = true,
): { position: [number, number, number]; heading: number } {
  const turn = furniture.rotation[2] ?? 0;
  const [x, y, z] = marker.offset;
  // Skyrim's z rotation turns clockwise seen from above (a heading: 0 faces +y).
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  return {
    position: [
      (furniture.position[0] ?? 0) + x * cos + y * sin,
      (furniture.position[1] ?? 0) - x * sin + y * cos,
      (furniture.position[2] ?? 0) + (height ? z : 0),
    ],
    heading: turn + marker.heading,
  };
}
