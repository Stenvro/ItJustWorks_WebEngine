// Distant LOD data that is not a NIF: a worldspace's LOD settings (lodsettings\<world>.lod),
// its tree types (meshes\terrain\<world>\trees\<world>.lst) and the trees of a block
// (<world>.<level>.<x>.<y>.btt). Layouts: docs/formats/lod.md.

import { BinaryReader, FormatError } from '../binary-reader.ts';

export interface LodSettings {
  /** South-west cell of the LOD grid. */
  readonly southWestX: number;
  readonly southWestY: number;
  /** Cells per side of the grid. */
  readonly stride: number;
  /** Cells per side of the smallest and largest LOD blocks (4 and 32). */
  readonly lowestLevel: number;
  readonly highestLevel: number;
}

export function parseLodSettings(bytes: Uint8Array): LodSettings {
  if (bytes.length < 16) throw new FormatError(`LOD settings: ${bytes.length} bytes`, 0);
  const reader = new BinaryReader(bytes);
  return {
    southWestX: reader.i16(),
    southWestY: reader.i16(),
    stride: reader.u32(),
    lowestLevel: reader.u32(),
    highestLevel: reader.u32(),
  };
}

/** A tree's billboard in the tree LOD atlas (<world>treelod.dds). */
export interface TreeLodType {
  readonly index: number;
  /** Billboard size in game units (before the reference's scale). */
  readonly width: number;
  readonly height: number;
  /** Atlas rectangle: u, v of the top-left and bottom-right corners. */
  readonly uv: readonly [number, number, number, number];
}

const TREE_TYPE_SIZE = 32;

export function parseTreeList(bytes: Uint8Array): TreeLodType[] {
  const reader = new BinaryReader(bytes);
  const count = reader.u32();
  if (4 + count * TREE_TYPE_SIZE > bytes.length) {
    throw new FormatError(`Tree list: ${count} types do not fit in ${bytes.length} bytes`, 0);
  }
  return Array.from({ length: count }, () => {
    const index = reader.u32();
    const width = reader.f32();
    const height = reader.f32();
    const uv: [number, number, number, number] = [
      reader.f32(),
      reader.f32(),
      reader.f32(),
      reader.f32(),
    ];
    reader.u32(); // unused
    return { index, width, height, uv };
  });
}

export interface TreeLodInstance {
  /** TreeLodType index. */
  readonly type: number;
  readonly position: readonly [number, number, number];
  /** Z rotation (radians). */
  readonly rotation: number;
  readonly scale: number;
  /** The tree reference (form id as stored in the plugin that owns the worldspace). */
  readonly reference: number;
}

const TREE_SIZE = 32;

export function parseTreeBlock(bytes: Uint8Array): TreeLodInstance[] {
  const reader = new BinaryReader(bytes);
  const groups = reader.u32();
  const trees: TreeLodInstance[] = [];
  for (let g = 0; g < groups; g++) {
    const type = reader.u32();
    const count = reader.u32();
    if (reader.offset + count * TREE_SIZE > bytes.length) {
      throw new FormatError(
        `Tree block: ${count} trees of type ${type} run past the end`,
        reader.offset,
      );
    }
    for (let i = 0; i < count; i++) {
      const position: [number, number, number] = [reader.f32(), reader.f32(), reader.f32()];
      const rotation = reader.f32();
      const scale = reader.f32();
      const reference = reader.u32();
      reader.skip(8); // unused
      trees.push({ type, position, rotation, scale, reference });
    }
  }
  // Some Dragonborn blocks carry more data after the declared groups (left by the Creation
  // Kit); only the declared groups count.
  return trees;
}
