import { BinaryReader, FormatError } from '../binary-reader.ts';
import { Fields, view, zstring } from './fields.ts';
import type { Field } from './record.ts';

// The TES4 record at the top of every plugin. `parsePluginHeader` only needs the first
// 12 bytes (for the load order); `parsePluginInfo` reads the full record.

export const PluginFlag = {
  master: 0x1,
  localized: 0x80,
  light: 0x200,
} as const;

/** Number of bytes needed to read the header. */
export const PLUGIN_HEADER_SIZE = 12;

export interface PluginHeader {
  readonly flags: number;
  readonly isMaster: boolean;
  readonly isLight: boolean;
  readonly isLocalized: boolean;
}

export function parsePluginHeader(bytes: Uint8Array): PluginHeader {
  const reader = new BinaryReader(bytes);
  const type = reader.fourCC();
  if (type !== 'TES4') throw new FormatError(`Not a plugin (record ${JSON.stringify(type)})`, 0);
  reader.u32(); // dataSize
  const flags = reader.u32();
  return {
    flags,
    isMaster: (flags & PluginFlag.master) !== 0,
    isLight: (flags & PluginFlag.light) !== 0,
    isLocalized: (flags & PluginFlag.localized) !== 0,
  };
}

export interface PluginInfo {
  /** HEDR: 1.7 for Skyrim SE (1.71 allows ESL form ids from 0x001). */
  readonly version: number;
  readonly recordCount: number;
  readonly nextObjectId: number;
  readonly author: string;
  readonly description: string;
  /** File names of the masters, in the order local form ids refer to them. */
  readonly masters: readonly string[];
  /** ONAM: form ids this plugin overrides (as stored). */
  readonly overrides: readonly number[];
}

/** Full TES4 record from its fields. */
export function parsePluginInfo(fieldList: readonly Field[]): PluginInfo {
  const fields = new Fields(fieldList);
  const hedr = fields.first('HEDR');
  if (!hedr || hedr.length < 12) throw new FormatError('TES4 without a valid HEDR field', 0);
  const header = view(hedr);
  const onam = fields.first('ONAM');
  const overrides: number[] = [];
  if (onam) {
    const onamView = view(onam);
    for (let offset = 0; offset + 4 <= onam.length; offset += 4) {
      overrides.push(onamView.getUint32(offset, true));
    }
  }
  return {
    version: header.getFloat32(0, true),
    recordCount: header.getInt32(4, true),
    nextObjectId: header.getUint32(8, true),
    author: fields.zstring('CNAM') ?? '',
    description: fields.zstring('SNAM') ?? '',
    masters: fields.all('MAST').map(zstring),
    overrides,
  };
}
