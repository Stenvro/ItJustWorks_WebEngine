// The original's save files, .ess (docs/formats/ess.md; UESP "Skyrim Mod:Save File Format",
// xEdit's wbDefinitionsTES5Saves): the header and screenshot, then (Special Edition, version
// 12) an LZ4 or zlib body with the plugin lists, the file location table, the three global
// data tables, the change forms, the form id array, the visited worldspaces and the unknown
// table 3. This reads the file's frame; the sections' contents are read by global-data.ts,
// papyrus.ts and change-forms.ts. Platform-independent; corrupt input throws FormatError.

import { FormatError } from '../binary-reader.ts';
import { decodeLz4Block } from '../lz4/lz4.ts';
import { inflateZlib } from '../zlib/inflate.ts';
import { EssReader, resolveRefId, type RawRefId } from './ess-reader.ts';

const MAGIC = 'TESV_SAVEGAME';

export interface EssHeader {
  /** 7 to 9: Legendary Edition; 12: Special Edition. */
  readonly version: number;
  readonly saveNumber: number;
  readonly playerName: string;
  readonly playerLevel: number;
  /** The location's (or cell's) name. */
  readonly location: string;
  /** The game time played as the save list shows it ("042.13.37"). */
  readonly gameDate: string;
  /** The player race's editor id. */
  readonly playerRace: string;
  /** 0 male, 1 female. */
  readonly playerSex: number;
  readonly playerExperience: number;
  readonly levelUpExperience: number;
  /** When it was saved: a Windows FILETIME (100 ns since 1601). */
  readonly fileTime: bigint;
  readonly screenshotWidth: number;
  readonly screenshotHeight: number;
  /** 0 none, 1 zlib, 2 LZ4 (Special Edition only; 0 before). */
  readonly compression: number;
}

/** One global data entry: its type and its bytes (read by global-data.ts). */
export interface GlobalData {
  readonly type: number;
  readonly data: Uint8Array;
}

/** A change form's frame: which form, what changed, and its (maybe compressed) data. */
export interface ChangeFormEntry {
  readonly refId: RawRefId;
  /** In the save's load order (undefined: a reference id of unknown kind). */
  readonly formId: number | undefined;
  readonly changeFlags: number;
  /** The change form type (0 REFR, 1 ACHR, ..., 8 QUST, 9 NPC_: CHANGE_FORM_TYPES). */
  readonly type: number;
  readonly version: number;
  /** The data as stored: zlib-compressed when uncompressedLength > 0. */
  readonly stored: Uint8Array;
  readonly uncompressedLength: number;
}

export interface FileLocationTable {
  readonly formIdArrayCountOffset: number;
  readonly unknownTable3Offset: number;
  readonly globalDataTable1Offset: number;
  readonly globalDataTable2Offset: number;
  readonly changeFormsOffset: number;
  readonly globalDataTable3Offset: number;
  readonly globalDataTable1Count: number;
  readonly globalDataTable2Count: number;
  readonly globalDataTable3Count: number;
  readonly changeFormCount: number;
}

export interface EssFile {
  readonly header: EssHeader;
  /** The screenshot's pixels: RGBA (Special Edition) or RGB (before). */
  readonly screenshot: Uint8Array;
  readonly screenshotChannels: 3 | 4;
  /** The body's form version (78 for the Special Edition with light plugins). */
  readonly formVersion: number;
  /** The plugins in the save's load order (index = a form id's top byte). */
  readonly plugins: readonly string[];
  /** The light plugins (index = a 0xFE form id's bits 12-23). */
  readonly lightPlugins: readonly string[];
  readonly locations: FileLocationTable;
  readonly globalData1: readonly GlobalData[];
  readonly globalData2: readonly GlobalData[];
  readonly globalData3: readonly GlobalData[];
  readonly changeForms: readonly ChangeFormEntry[];
  /** The form ids indexed reference ids name (RefIdKind.Indexed). */
  readonly formIds: Uint32Array;
  readonly visitedWorldspaces: readonly number[];
  readonly unknownTable3: readonly string[];
}

/** The change form types by number (xEdit's wbChangeTypes). */
export const CHANGE_FORM_TYPES = [
  'REFR', 'ACHR', 'PMIS', 'PGRE', 'PBEA', 'PFLA', 'CELL', 'INFO', 'QUST', 'NPC_', 'ACTI',
  'TACT', 'ARMO', 'BOOK', 'CONT', 'DOOR', 'INGR', 'LIGH', 'MISC', 'APPA', 'STAT', 'MSTT',
  'FURN', 'WEAP', 'AMMO', 'KEYM', 'ALCH', 'IDLM', 'NOTE', 'ECZN', 'CLAS', 'FACT', 'PACK',
  'NAVM', 'WOOP', 'MGEF', 'SMQN', 'SCEN', 'LCTN', 'RELA', 'PHZD', 'PBAR', 'PCON', 'FLST',
  'LVLN', 'LVLI', 'LVSP', 'PARW', 'ENCH',
] as const; // prettier-ignore

export function changeFormTypeName(type: number): string {
  return CHANGE_FORM_TYPES[type] ?? `type ${String(type)}`;
}

/** Reads the header alone (a save list): no body is unpacked. */
export function readEssHeader(bytes: Uint8Array): { header: EssHeader; bodyStart: number } {
  const reader = new EssReader(bytes);
  const magic = String.fromCharCode(...reader.bytes(MAGIC.length));
  if (magic !== MAGIC) throw new FormatError('Not a Skyrim save file', 0);
  const headerSize = reader.u32();
  const headerStart = reader.offset;
  const version = reader.u32();
  if (version < 7 || version > 12) {
    throw new FormatError(`Unknown save version ${String(version)}`, headerStart);
  }
  const header: EssHeader = {
    version,
    saveNumber: reader.u32(),
    playerName: reader.wstring(),
    playerLevel: reader.u32(),
    location: reader.wstring(),
    gameDate: reader.wstring(),
    playerRace: reader.wstring(),
    playerSex: reader.u16(),
    playerExperience: reader.f32(),
    levelUpExperience: reader.f32(),
    fileTime: reader.u64(),
    screenshotWidth: reader.u32(),
    screenshotHeight: reader.u32(),
    compression: version >= 12 ? reader.u16() : 0,
  };
  // The header's size is written: what follows starts there (whatever this reads of it).
  return { header, bodyStart: headerStart + headerSize };
}

/** Reads a whole save's frame (the sections' bytes, the change forms' frames). */
export function readEss(bytes: Uint8Array): EssFile {
  const { header, bodyStart } = readEssHeader(bytes);
  const outer = new EssReader(bytes, bodyStart);
  const screenshotChannels = header.version >= 12 ? 4 : 3;
  const screenshot = outer.bytes(
    screenshotChannels * header.screenshotWidth * header.screenshotHeight,
  );
  let body: Uint8Array;
  if (header.version >= 12) {
    const uncompressed = outer.u32();
    const compressed = outer.u32();
    const start = outer.offset;
    const stored = outer.bytes(Math.min(compressed, outer.remaining));
    if (header.compression === 2) {
      body = new Uint8Array(uncompressed);
      const end = decodeLz4Block(stored, 0, stored.length, body, 0);
      if (end !== uncompressed) {
        throw new FormatError(
          `LZ4 body is ${String(end)} bytes, the header says ${String(uncompressed)}`,
          start,
        );
      }
    } else if (header.compression === 1) {
      body = inflateZlib(stored, uncompressed);
    } else {
      body = bytes.subarray(start);
    }
  } else {
    body = bytes.subarray(outer.offset);
  }
  return readBody(header, screenshot, screenshotChannels, body);
}

function readGlobalData(
  reader: EssReader,
  count: number,
  first: number,
  last: number,
): GlobalData[] {
  const entries: GlobalData[] = [];
  for (let i = 0; i < count; i++) entries.push(readGlobalEntry(reader));
  if (first !== 1000) return entries;
  // Table 3's count is one short (UESP; xEdit reads one more): read on while the next entry
  // is of the table's types and after the last one read.
  while (reader.remaining >= 8) {
    const at = reader.offset;
    const type = reader.u32();
    reader.seek(at);
    const previous = entries.at(-1)?.type ?? first - 1;
    if (type < first || type > last || type <= previous) break;
    entries.push(readGlobalEntry(reader));
  }
  return entries;
}

function readGlobalEntry(reader: EssReader): GlobalData {
  const type = reader.u32();
  const length = reader.u32();
  return { type, data: reader.bytes(length) };
}

function readBody(
  header: EssHeader,
  screenshot: Uint8Array,
  screenshotChannels: 3 | 4,
  body: Uint8Array,
): EssFile {
  const reader = new EssReader(body);
  const formVersion = reader.u8();
  const pluginInfoSize = reader.u32();
  const pluginsStart = reader.offset;
  const plugins: string[] = [];
  const pluginCount = reader.u8();
  for (let i = 0; i < pluginCount; i++) plugins.push(reader.wstring());
  const lightPlugins: string[] = [];
  if (formVersion >= 78) {
    const lightCount = reader.u16();
    for (let i = 0; i < lightCount; i++) lightPlugins.push(reader.wstring());
  }
  if (reader.offset !== pluginsStart + pluginInfoSize) reader.seek(pluginsStart + pluginInfoSize);
  const locations: FileLocationTable = {
    formIdArrayCountOffset: reader.u32(),
    unknownTable3Offset: reader.u32(),
    globalDataTable1Offset: reader.u32(),
    globalDataTable2Offset: reader.u32(),
    changeFormsOffset: reader.u32(),
    globalDataTable3Offset: reader.u32(),
    globalDataTable1Count: reader.u32(),
    globalDataTable2Count: reader.u32(),
    globalDataTable3Count: reader.u32(),
    changeFormCount: reader.u32(),
  };
  reader.skip(15 * 4);
  const globalData1 = readGlobalData(reader, locations.globalDataTable1Count, 0, 8);
  const globalData2 = readGlobalData(reader, locations.globalDataTable2Count, 100, 114);
  const frames: Omit<ChangeFormEntry, 'formId'>[] = [];
  for (let i = 0; i < locations.changeFormCount; i++) {
    const refId = reader.refId();
    const changeFlags = reader.u32();
    const typeByte = reader.u8();
    const version = reader.u8();
    const lengthSize = typeByte >>> 6;
    const readLength = (): number =>
      lengthSize === 0 ? reader.u8() : lengthSize === 1 ? reader.u16() : reader.u32();
    if (lengthSize > 2) {
      throw new FormatError(`Change form ${String(i)} has an invalid length size`, reader.offset);
    }
    const length = readLength();
    const uncompressedLength = readLength();
    frames.push({
      refId,
      changeFlags,
      type: typeByte & 0x3f,
      version,
      stored: reader.bytes(length),
      uncompressedLength,
    });
  }
  const globalData3 = readGlobalData(reader, locations.globalDataTable3Count, 1000, 1005);
  const formIdCount = reader.u32();
  const formIds = new Uint32Array(formIdCount);
  for (let i = 0; i < formIdCount; i++) formIds[i] = reader.u32();
  const visitedWorldspaces: number[] = [];
  const visitedCount = reader.u32();
  for (let i = 0; i < visitedCount; i++) visitedWorldspaces.push(reader.u32());
  const unknownTable3: string[] = [];
  if (reader.remaining >= 8) {
    reader.u32(); // the table's size
    const count = reader.u32();
    for (let i = 0; i < count && reader.remaining >= 2; i++) unknownTable3.push(reader.wstring());
  }
  return {
    header,
    screenshot,
    screenshotChannels,
    formVersion,
    plugins,
    lightPlugins,
    locations,
    globalData1,
    globalData2,
    globalData3,
    changeForms: frames.map((frame) => ({ ...frame, formId: resolveRefId(frame.refId, formIds) })),
    formIds,
    visitedWorldspaces,
    unknownTable3,
  };
}

/** A change form's data, inflated when compressed. */
export function changeFormData(entry: ChangeFormEntry): Uint8Array {
  return entry.uncompressedLength > 0
    ? inflateZlib(entry.stored, entry.uncompressedLength)
    : entry.stored;
}

/** The global data entry of a type (in whichever table holds it). */
export function globalData(file: EssFile, type: number): Uint8Array | undefined {
  for (const table of [file.globalData1, file.globalData2, file.globalData3]) {
    const entry = table.find((candidate) => candidate.type === type);
    if (entry) return entry.data;
  }
  return undefined;
}
