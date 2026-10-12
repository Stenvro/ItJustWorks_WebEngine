// NIF header (Gamebryo 20.2.0.7 with the Bethesda stream header). Format: docs/formats/nif.md

import { BinaryReader, FormatError } from '../binary-reader.ts';
import { decodeWindows1252 } from '../text.ts';

export const NIF_VERSION_SSE = 0x14020007; // 20.2.0.7
export const BS_VERSION_SSE = 100;

export interface NifHeader {
  readonly version: number;
  readonly userVersion: number;
  /** Bethesda version: 83 = Skyrim LE, 100 = Skyrim SE, 130+ = Fallout 4. */
  readonly bsVersion: number;
  readonly author: string;
  readonly processScript: string;
  readonly exportScript: string;
  readonly blockTypes: readonly string[];
  /** Per block: index into `blockTypes`. */
  readonly blockTypeIndices: readonly number[];
  /** Per block: size in bytes. */
  readonly blockSizes: readonly number[];
  readonly strings: readonly string[];
  /** Byte offset of the first block. */
  readonly dataOffset: number;
}

/** u32 length + characters. */
export function readSizedString(reader: BinaryReader): string {
  const length = reader.u32();
  if (length > reader.remaining) {
    throw new FormatError(`String of ${length} bytes runs past the end`, reader.offset - 4);
  }
  return decodeWindows1252(reader.bytes(length));
}

/** u8 length (including the terminating null) + characters. */
function readExportString(reader: BinaryReader): string {
  const bytes = reader.bytes(reader.u8());
  const end = bytes.indexOf(0);
  return decodeWindows1252(bytes, 0, end === -1 ? bytes.length : end);
}

export function parseNifHeader(bytes: Uint8Array): NifHeader {
  const newline = bytes.indexOf(0x0a);
  if (newline < 0 || newline > 128) throw new FormatError('Not a NIF file (no header line)', 0);
  const headerLine = decodeWindows1252(bytes, 0, newline);
  if (!headerLine.startsWith('Gamebryo File Format')) {
    throw new FormatError(`Not a NIF file: ${JSON.stringify(headerLine.slice(0, 40))}`, 0);
  }

  const reader = new BinaryReader(bytes, newline + 1);
  const version = reader.u32();
  if (version !== NIF_VERSION_SSE) {
    throw new FormatError(
      `NIF version 0x${version.toString(16)} not supported (SSE: 20.2.0.7)`,
      newline + 1,
    );
  }
  const endian = reader.u8();
  if (endian !== 1) throw new FormatError('Big-endian NIF not supported', reader.offset - 1);
  const userVersion = reader.u32();
  const blockCount = reader.u32();

  const bsVersion = reader.u32();
  const author = readExportString(reader);
  if (bsVersion > 130) reader.u32(); // unknown field (Fallout 4+)
  const processScript = bsVersion < 131 ? readExportString(reader) : '';
  const exportScript = readExportString(reader);
  if (bsVersion >= 103) readExportString(reader); // max filepath (Fallout 4+)

  const blockTypeCount = reader.u16();
  const blockTypes = Array.from({ length: blockTypeCount }, () => readSizedString(reader));
  const blockTypeIndices = Array.from({ length: blockCount }, () => {
    // The high bit marks PhysX blocks (Fallout 4); it is not part of the index.
    const index = reader.u16() & 0x7fff;
    if (index >= blockTypeCount) {
      throw new FormatError(`Block type index ${index} out of range`, reader.offset - 2);
    }
    return index;
  });
  const blockSizes = Array.from({ length: blockCount }, () => reader.u32());

  const stringCount = reader.u32();
  reader.u32(); // maximum string length
  const strings = Array.from({ length: stringCount }, () => readSizedString(reader));

  const groupCount = reader.u32();
  reader.skip(groupCount * 4);

  return {
    version,
    userVersion,
    bsVersion,
    author,
    processScript,
    exportScript,
    blockTypes,
    blockTypeIndices,
    blockSizes,
    strings,
    dataOffset: reader.offset,
  };
}
