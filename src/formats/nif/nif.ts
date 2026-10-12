// NIF file: header, blocks and footer. Format: docs/formats/nif.md

import { BinaryReader, FormatError } from '../binary-reader.ts';
import { BLOCK_PARSERS } from './blocks.ts';
import { ANIMATION_PARSERS } from './animation-blocks.ts';
import { PARTICLE_PARSERS } from './particle-blocks.ts';
import { COLLISION_PARSERS } from './collision-blocks.ts';
import { parseNifHeader, type NifHeader } from './header.ts';
import type { NifBlock, Ref } from './types.ts';

export interface NifFile {
  readonly header: NifHeader;
  readonly blocks: readonly NifBlock[];
  /** Type name per block, e.g. `BSFadeNode`. */
  readonly blockTypes: readonly string[];
  readonly roots: readonly Ref[];
  /**
   * Blocks that failed to parse or were not consumed exactly. They are kept as
   * `unknown`, so the rest of the file stays usable.
   */
  readonly problems: readonly string[];
}

type BlockOfKind<K extends NifBlock['kind']> = Extract<NifBlock, { kind: K }>;

/** Block at `ref` if it exists and has the expected kind. */
export function getBlock<K extends NifBlock['kind']>(
  file: NifFile,
  ref: Ref,
  kind: K,
): BlockOfKind<K> | undefined {
  const block = ref >= 0 ? file.blocks[ref] : undefined;
  return block?.kind === kind ? (block as BlockOfKind<K>) : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseNif(bytes: Uint8Array): NifFile {
  const header = parseNifHeader(bytes);
  const context = { strings: header.strings, bsVersion: header.bsVersion };
  const blocks: NifBlock[] = [];
  const blockTypes: string[] = [];
  const problems: string[] = [];

  let offset = header.dataOffset;
  header.blockSizes.forEach((size, index) => {
    const type = header.blockTypes[header.blockTypeIndices[index] ?? -1] ?? '?';
    blockTypes.push(type);
    if (offset + size > bytes.length) {
      throw new FormatError(`Block ${index} (${type}) runs past the end of the file`, offset);
    }
    const parser =
      BLOCK_PARSERS.get(type) ??
      ANIMATION_PARSERS.get(type) ??
      PARTICLE_PARSERS.get(type) ??
      COLLISION_PARSERS.get(type);
    let block: NifBlock = { kind: 'unknown' };
    if (parser) {
      const reader = new BinaryReader(bytes.subarray(offset, offset + size));
      try {
        block = parser(reader, context, type);
        if (reader.remaining !== 0) {
          problems.push(`${type} #${index}: ${reader.remaining} of ${size} bytes not parsed`);
          block = { kind: 'unknown' };
        }
      } catch (error) {
        problems.push(`${type} #${index}: ${describe(error)}`);
        block = { kind: 'unknown' };
      }
    }
    blocks.push(block);
    offset += size;
  });

  const footer = new BinaryReader(bytes, offset);
  const roots = Array.from({ length: footer.u32() }, () => footer.i32());
  return { header, blocks, blockTypes, roots, problems };
}
