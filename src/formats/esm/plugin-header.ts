import { BinaryReader, FormatError } from '../binary-reader.ts';

// Alleen de vlaggen uit het TES4-record bovenaan een plugin: genoeg voor de laadvolgorde.
// Het volledige ESM-formaat volgt in M3.

export const PluginFlag = {
  master: 0x1,
  localized: 0x80,
  light: 0x200,
} as const;

/** Aantal bytes dat nodig is om de header te lezen. */
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
