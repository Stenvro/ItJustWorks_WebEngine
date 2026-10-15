// Bakes a head part's shape for a made-up face (the player's), as the FaceGen heads of NPCs
// come baked: the part's own mesh plus the race morph, the chargen morphs and SkinnyMorph of its
// TRI files at the weights of chargenMorphWeights (src/gameplay/chargen.ts). Done on the CPU
// once per change; the expressions stay on the GPU on top. Platform-independent.

import type { NifFile } from '../formats/nif/nif.ts';
import type { TriFile } from '../formats/nif/tri.ts';
import { HeadPartFile, type HeadPartRecord } from '../world/actor-records.ts';
import { meshPath } from '../world/actors.ts';

/** A head part's morph files (HDPT NAM0 / NAM1), parsed. */
export interface HeadPartMorphs {
  /** NAM0 0: one morph per race (`NordRace`, ...). */
  readonly race?: TriFile | undefined;
  /** NAM0 2: the chargen morphs (NAM9 pairs, NoseType1.., ...). */
  readonly chargen?: TriFile | undefined;
  /** NAM0 1: the expressions; of those only SkinnyMorph has a chargen weight. */
  readonly expressions?: TriFile | undefined;
}

/** The VFS paths of a head part's morph files. */
export function headPartMorphPaths(part: Pick<HeadPartRecord, 'files'>): {
  race: string | undefined;
  chargen: string | undefined;
  expressions: string | undefined;
} {
  const path = (type: number): string | undefined => {
    const file = part.files.find((f) => f.type === type);
    return file && meshPath(file.path);
  };
  return {
    race: path(HeadPartFile.raceMorph),
    chargen: path(HeadPartFile.chargenMorph),
    expressions: path(HeadPartFile.tri),
  };
}

/**
 * The positions the morphs apply to: the head part model's own (its BSDynamicTriShape, x, y,
 * z, w per vertex). Not the TRI files' base meshes: those differ from the model by up to 0.48
 * units (MaleHeadNord 0.055, FemaleHeadNord 0.22, some hair), and the baked FaceGen heads are
 * the model plus the morph offsets.
 */
export function headPartBasePositions(nif: NifFile): Float32Array | undefined {
  for (const block of nif.blocks) {
    if (block.kind === 'tri-shape' && block.dynamicPositions) return block.dynamicPositions;
  }
  return undefined;
}

/**
 * The part's baked positions, in the layout of `base` (`stride` floats per vertex, x, y, z
 * first; the TRI files have the model's vertices in the same order): every morph of its files
 * with a weight added (by lower-case name; each name once, the race file first). Files with
 * another vertex count are left out.
 */
export function bakeHeadPart(
  base: Float32Array,
  stride: number,
  morphs: HeadPartMorphs,
  weights: ReadonlyMap<string, number>,
): Float32Array {
  const positions = base.slice();
  const vertexCount = Math.floor(base.length / stride);
  const applied = new Set<string>();
  for (const file of [morphs.race, morphs.chargen, morphs.expressions]) {
    if (file?.vertexCount !== vertexCount) continue;
    for (const morph of file.morphs) {
      const key = morph.name.toLowerCase();
      const weight = weights.get(key);
      if (weight === undefined || weight === 0 || applied.has(key)) continue;
      applied.add(key);
      const { offsets } = morph;
      for (let v = 0; v < vertexCount; v++) {
        for (let k = 0; k < 3; k++) {
          const at = v * stride + k;
          positions[at] = (positions[at] ?? 0) + (offsets[v * 3 + k] ?? 0) * weight;
        }
      }
    }
  }
  return positions;
}
