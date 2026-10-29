// Parsers for the NIF extra data blocks that hold plain values (booleans, floats, strings,
// bytes), the inventory marker, decal placement vectors, bone LOD distances, and the room
// bounds of BSMultiBoundNode. Field order follows nif.xml for 20.2.0.7 / BS version 100.
// Notes: docs/formats/nif.md ("Extra data").

import type { BinaryReader } from '../binary-reader.ts';
import { readCount, readFloats, readStringRef, readVec3, type BlockParser } from './blocks.ts';
import { readSizedString } from './header.ts';
import type {
  BoneLodExtraDataBlock,
  DecalPlacementBlock,
  InvMarkerBlock,
  MultiBoundBlock,
  MultiBoundDataBlock,
  ValueExtraDataBlock,
} from './types.ts';

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;

const parseValueExtraData: BlockParser = (reader, context, type): ValueExtraDataBlock => {
  const name = readStringRef(reader, context);
  let value: ValueExtraDataBlock['value'];
  switch (type) {
    case 'NiBooleanExtraData':
      value = reader.u8() !== 0;
      break;
    case 'NiFloatExtraData':
      value = reader.f32();
      break;
    case 'NiStringsExtraData':
      // Sized strings of their own, not header string indices (nif.xml SizedString).
      value = Array.from({ length: reader.u32() }, () => readSizedString(reader));
      break;
    default: {
      const size = readCount(reader, 1);
      value = reader.bytes(size).slice();
    }
  }
  return { kind: 'value-extra-data', type, name, value };
};

const parseInvMarker: BlockParser = (reader, context): InvMarkerBlock => ({
  kind: 'inv-marker',
  name: readStringRef(reader, context),
  rotation: [reader.u16(), reader.u16(), reader.u16()],
  zoom: reader.f32(),
});

/** NiFloatExtraData's value, then u16 blocks of (u16 count, points, normals). */
const parseDecalPlacement: BlockParser = (reader, context): DecalPlacementBlock => {
  const name = readStringRef(reader, context);
  const value = reader.f32();
  const blocks = Array.from({ length: reader.u16() }, () => {
    const count = reader.u16();
    const points = readFloats(reader, count * 3);
    const normals = readFloats(reader, count * 3);
    return { points, normals };
  });
  return { kind: 'decal-placement', name, value, blocks };
};

const parseBoneLodExtraData: BlockParser = (reader, context): BoneLodExtraDataBlock => {
  const name = readStringRef(reader, context);
  const levels = Array.from({ length: reader.u32() }, () => ({
    distance: reader.u32(),
    bone: readStringRef(reader, context),
  }));
  return { kind: 'bone-lod-extra-data', name, levels };
};

const parseMultiBound: BlockParser = (reader): MultiBoundBlock => ({
  kind: 'multi-bound',
  data: reader.i32(),
});

function readMatrix33(reader: BinaryReader): number[] {
  return Array.from(readFloats(reader, 9));
}

const parseMultiBoundData: BlockParser = (reader, _context, type): MultiBoundDataBlock => {
  const center = readVec3(reader);
  const extent = readVec3(reader);
  const rotation = type === 'BSMultiBoundOBB' ? readMatrix33(reader) : [...IDENTITY];
  return { kind: 'multi-bound-data', type, center, extent, rotation };
};

export const EXTRA_PARSERS: ReadonlyMap<string, BlockParser> = new Map<string, BlockParser>([
  ['NiBooleanExtraData', parseValueExtraData],
  ['NiFloatExtraData', parseValueExtraData],
  ['NiStringsExtraData', parseValueExtraData],
  ['NiBinaryExtraData', parseValueExtraData],
  ['BSInvMarker', parseInvMarker],
  ['BSDecalPlacementVectorExtraData', parseDecalPlacement],
  ['BSBoneLODExtraData', parseBoneLodExtraData],
  ['BSMultiBound', parseMultiBound],
  ['BSMultiBoundOBB', parseMultiBoundData],
  ['BSMultiBoundAABB', parseMultiBoundData],
]);
