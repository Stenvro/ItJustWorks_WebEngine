// Generic plugin (ESM/ESP/ESL) structure: record and group headers, fields, compressed
// record data. Format: docs/formats/esm.md

import { BinaryReader, FormatError } from '../binary-reader.ts';
import { inflateZlib } from '../zlib/inflate.ts';

export const RECORD_HEADER_SIZE = 24;
export const GROUP_HEADER_SIZE = 24;

/** Record flags (meaning depends on the record type for some bits). */
export const RecordFlag = {
  master: 0x1, // TES4
  /** ARMO: not playable (never shown in a menu). */
  nonPlayable: 0x4,
  deleted: 0x20,
  localized: 0x80, // TES4: FULL/DESC/... are string table ids
  light: 0x200, // TES4: ESL
  /** ACHR: the actor is dead when the game starts (its ragdoll lies where it falls). */
  startsDead: 0x200,
  persistent: 0x400, // REFR/ACHR
  initiallyDisabled: 0x800,
  ignored: 0x1000,
  /**
   * REFR: a sky marker (xEdit's name), a point in the air: a flier flies to it rather than
   * landing there (docs/ai.md, "Flying").
   */
  skyMarker: 0x2000,
  visibleWhenDistant: 0x8000,
  /** Base objects (STAT, FURN, ...): an editor marker, never drawn in game. */
  isMarker: 0x800000,
  compressed: 0x40000,
  /** REFR: never reset with its cell (xEdit "No Respawn"; the engine's reset skips it). */
  noRespawn: 0x40000000,
} as const;

export const GroupType = {
  top: 0,
  worldChildren: 1,
  interiorCellBlock: 2,
  interiorCellSubBlock: 3,
  exteriorCellBlock: 4,
  exteriorCellSubBlock: 5,
  cellChildren: 6,
  topicChildren: 7,
  cellPersistentChildren: 8,
  cellTemporaryChildren: 9,
} as const;

export interface RecordHeader {
  readonly type: string;
  readonly dataSize: number;
  readonly flags: number;
  readonly formId: number;
  readonly formVersion: number;
}

export interface GroupHeader {
  /** Size including this header. */
  readonly size: number;
  /** Raw label: a record type, form id or block number depending on `groupType`. */
  readonly label: number;
  readonly groupType: number;
}

export interface Field {
  readonly type: string;
  readonly data: Uint8Array;
}

/** Four-character code from a u32 (little-endian), e.g. 0x4C4C4543 → "CELL". */
export function fourCCFromInt(value: number): string {
  return String.fromCharCode(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  );
}

export function fourCCToInt(code: string): number {
  return (
    (code.charCodeAt(0) |
      (code.charCodeAt(1) << 8) |
      (code.charCodeAt(2) << 16) |
      (code.charCodeAt(3) << 24)) >>>
    0
  );
}

export const GRUP = fourCCToInt('GRUP');

export function parseRecordHeader(bytes: Uint8Array, offset = 0): RecordHeader {
  const reader = new BinaryReader(bytes, offset);
  const type = reader.fourCC();
  const dataSize = reader.u32();
  const flags = reader.u32();
  const formId = reader.u32();
  reader.skip(4); // version control info
  const formVersion = reader.u16();
  return { type, dataSize, flags, formId, formVersion };
}

export function parseGroupHeader(bytes: Uint8Array, offset = 0): GroupHeader {
  const reader = new BinaryReader(bytes, offset);
  if (reader.fourCC() !== 'GRUP') throw new FormatError('Expected a GRUP header', offset);
  const size = reader.u32();
  const label = reader.u32();
  const groupType = reader.i32();
  if (size < GROUP_HEADER_SIZE) throw new FormatError(`Invalid group size ${size}`, offset + 4);
  return { size, label, groupType };
}

/**
 * The record's field data: decompressed if the record is compressed
 * (u32 decompressed size + zlib stream).
 */
export function recordData(header: RecordHeader, stored: Uint8Array): Uint8Array {
  if ((header.flags & RecordFlag.compressed) === 0) return stored;
  if (stored.length < 4) throw new FormatError('Compressed record too short', 0);
  const size = new DataView(stored.buffer, stored.byteOffset, 4).getUint32(0, true);
  return inflateZlib(stored.subarray(4), size);
}

/** Splits record data into fields. `XXXX` fields carry the size of the next field. */
export function parseFields(data: Uint8Array): Field[] {
  const reader = new BinaryReader(data);
  const fields: Field[] = [];
  let sizeOverride: number | undefined;
  while (reader.remaining > 0) {
    if (reader.remaining < 6) {
      throw new FormatError(
        `${reader.remaining} trailing bytes after the last field`,
        reader.offset,
      );
    }
    const type = reader.fourCC();
    let size = reader.u16();
    if (type === 'XXXX') {
      if (size !== 4) throw new FormatError('XXXX field must be 4 bytes', reader.offset - 2);
      sizeOverride = reader.u32();
      continue;
    }
    if (sizeOverride !== undefined) {
      size = sizeOverride;
      sizeOverride = undefined;
    }
    if (size > reader.remaining) {
      throw new FormatError(
        `Field ${type} (${size} bytes) runs past the record`,
        reader.offset - 2,
      );
    }
    fields.push({ type, data: reader.bytes(size) });
  }
  return fields;
}
