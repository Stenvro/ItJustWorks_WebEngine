// Large references (Skyrim SE): big objects (mountains, cliffs, city walls, forts) that the
// engine loads in full detail in a wider grid than the normal cells (uLargeRefLODGridSize, 11
// cells across), while their LOD gives way there. Each plugin's version of a worldspace record
// lists, in RNAM, the large references it adds: one field per cell their bounds reach into.
// Platform-independent. Layout: docs/formats/esm.md ("Large references").

import { view } from '../formats/esm/fields.ts';

/** Cells across the grid in which large references are loaded (uLargeRefLODGridSize). */
export const LARGE_REFERENCE_GRID = 11;

export interface LargeReference {
  /** Global form id of the reference. */
  readonly formId: number;
  /** The cell the reference is placed in. */
  readonly cellX: number;
  readonly cellY: number;
}

/** What a worldspace record version offers to read its RNAM fields. */
export interface LargeReferenceSource {
  readonly fields: { all(type: string): Uint8Array[] };
  /** A form id in this version's data, as a global form id. */
  formIdAt(data: Uint8Array, offset: number): number;
}

/**
 * The large references of a worldspace from all versions of its record (every plugin lists
 * its own), by the cells they reach into ("x,y"). RNAM: i16 cell Y, i16 cell X, u32 count,
 * then per reference a form id, i16 Y and i16 X of the cell it is placed in.
 */
export function parseLargeReferences(
  versions: readonly LargeReferenceSource[],
): Map<string, LargeReference[]> {
  const byCell = new Map<string, Map<number, LargeReference>>();
  for (const version of versions) {
    for (const data of version.fields.all('RNAM')) {
      if (data.length < 8) continue;
      const v = view(data);
      const cellY = v.getInt16(0, true);
      const cellX = v.getInt16(2, true);
      const count = Math.min(v.getUint32(4, true), Math.floor((data.length - 8) / 8));
      const key = `${String(cellX)},${String(cellY)}`;
      let refs = byCell.get(key);
      if (!refs) {
        refs = new Map();
        byCell.set(key, refs);
      }
      for (let i = 0; i < count; i++) {
        const offset = 8 + i * 8;
        const formId = version.formIdAt(data, offset);
        refs.set(formId, {
          formId,
          cellY: v.getInt16(offset + 4, true),
          cellX: v.getInt16(offset + 6, true),
        });
      }
    }
  }
  const result = new Map<string, LargeReference[]>();
  for (const [key, refs] of byCell) result.set(key, [...refs.values()]);
  return result;
}

/**
 * The large references to show with the camera in cell (x, y), grouped by the cell they are
 * placed in: every reference listed for a cell of the grid around it.
 */
export function largeReferencesAround(
  byCell: ReadonlyMap<string, readonly LargeReference[]>,
  x: number,
  y: number,
  grid = LARGE_REFERENCE_GRID,
): Map<string, Set<number>> {
  const radius = Math.floor(grid / 2);
  const result = new Map<string, Set<number>>();
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (const ref of byCell.get(`${String(x + dx)},${String(y + dy)}`) ?? []) {
        const key = `${String(ref.cellX)},${String(ref.cellY)}`;
        let set = result.get(key);
        if (!set) {
          set = new Set();
          result.set(key, set);
        }
        set.add(ref.formId);
      }
    }
  }
  return result;
}
