// Load order of plugins and archives, as Skyrim SE determines it.
// Explanation and sources: docs/formats/load-order.md

import type { PluginHeader } from '../formats/esm/plugin-header.ts';
import { iniValue, splitIniList, type Ini } from '../formats/ini/ini.ts';
import { asciiLowerCase } from '../formats/text.ts';

/** Masters the engine always loads first, in this order (if present). */
export const IMPLICIT_MASTERS = [
  'Skyrim.esm',
  'Update.esm',
  'Dawnguard.esm',
  'HearthFires.esm',
  'Dragonborn.esm',
] as const;

/** `sResourceArchiveList` + `sResourceArchiveList2` from Skyrim_Default.ini (English). */
export const DEFAULT_ARCHIVE_LIST = [
  'Skyrim - Misc.bsa',
  'Skyrim - Shaders.bsa',
  'Skyrim - Interface.bsa',
  'Skyrim - Animations.bsa',
  'Skyrim - Meshes0.bsa',
  'Skyrim - Meshes1.bsa',
  'Skyrim - Sounds.bsa',
  'Skyrim - Voices_en0.bsa',
  ...Array.from({ length: 9 }, (_, i) => `Skyrim - Textures${i}.bsa`),
  'Skyrim - Patch.bsa',
] as const;

/** Full plugins get index 0x00-0xFD; 0xFE is for light plugins (ESL). */
const MAX_FULL_PLUGINS = 0xfe;
const MAX_LIGHT_PLUGINS = 0x1000;

export interface PluginCandidate {
  /** File name in Data/. */
  readonly name: string;
  /** `undefined` if the header is unreadable; then only the extension counts. */
  readonly header: PluginHeader | undefined;
}

export type PluginSource = 'implicit' | 'Skyrim.ccc' | 'plugins.txt';

export interface LoadOrderEntry {
  readonly name: string;
  readonly isMaster: boolean;
  readonly isLight: boolean;
  /** 0x00-0xFD, of 0xFE voor light plugins. */
  readonly modIndex: number;
  /** 0x000-0xFFF within 0xFE; light plugins only. */
  readonly lightIndex: number | undefined;
  readonly source: PluginSource;
}

export interface LoadOrderResult {
  readonly entries: readonly LoadOrderEntry[];
  readonly problems: readonly string[];
}

function lines(text: string | undefined): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : asciiLowerCase(name.slice(dot));
}

/**
 * Determines which plugins are active and in what order:
 * 1. implicit masters, 2. Creation Club plugins from Skyrim.ccc, 3. active lines (`*`) from
 * plugins.txt. Masters (ESM flag, .esm or .esl) are then placed before non-masters.
 */
export function computeLoadOrder(input: {
  readonly plugins: readonly PluginCandidate[];
  readonly ccc?: string | undefined;
  readonly pluginsTxt?: string | undefined;
}): LoadOrderResult {
  const present = new Map(input.plugins.map((p) => [asciiLowerCase(p.name), p]));
  const used = new Set<string>();
  const problems: string[] = [];
  const ordered: { candidate: PluginCandidate; source: PluginSource }[] = [];

  const add = (name: string, source: PluginSource): void => {
    const key = asciiLowerCase(name);
    if (used.has(key)) return;
    const candidate = present.get(key);
    if (!candidate) {
      if (source === 'plugins.txt') problems.push(`${name} is listed in plugins.txt but missing`);
      return;
    }
    used.add(key);
    ordered.push({ candidate, source });
  };

  for (const name of IMPLICIT_MASTERS) add(name, 'implicit');
  for (const name of lines(input.ccc)) add(name, 'Skyrim.ccc');
  for (const line of lines(input.pluginsTxt)) {
    if (line.startsWith('*')) add(line.slice(1).trim(), 'plugins.txt');
  }

  const classified = ordered.map(({ candidate, source }) => {
    const extension = extensionOf(candidate.name);
    const isLight = extension === '.esl' || (candidate.header?.isLight ?? false);
    const isMaster =
      extension === '.esm' || extension === '.esl' || (candidate.header?.isMaster ?? false);
    return { name: candidate.name, source, isLight, isMaster };
  });
  const sorted = [
    ...classified.filter((p) => p.isMaster),
    ...classified.filter((p) => !p.isMaster),
  ];

  const entries: LoadOrderEntry[] = [];
  let full = 0;
  let light = 0;
  for (const plugin of sorted) {
    if (plugin.isLight) {
      if (light >= MAX_LIGHT_PLUGINS) {
        problems.push(`${plugin.name} not loaded: at most ${MAX_LIGHT_PLUGINS} light plugins`);
        continue;
      }
      entries.push({ ...plugin, modIndex: 0xfe, lightIndex: light++ });
    } else {
      if (full >= MAX_FULL_PLUGINS) {
        problems.push(`${plugin.name} not loaded: at most ${MAX_FULL_PLUGINS} full plugins`);
        continue;
      }
      entries.push({ ...plugin, modIndex: full++, lightIndex: undefined });
    }
  }
  return { entries, problems };
}

/** Archive list from the INI, or the default list if it is missing. */
export function archiveListFromIni(ini: Ini | undefined): readonly string[] {
  if (!ini) return DEFAULT_ARCHIVE_LIST;
  const list = [
    ...splitIniList(iniValue(ini, 'Archive', 'sResourceArchiveList')),
    ...splitIniList(iniValue(ini, 'Archive', 'sResourceArchiveList2')),
  ];
  return list.length > 0 ? list : DEFAULT_ARCHIVE_LIST;
}

/**
 * Archives in load order (low → high; later wins on conflicts):
 * first the INI list, then per plugin `<name>.bsa` and `<name> - Textures.bsa`.
 * Non-existent archives are skipped, as in the original.
 */
export function computeArchiveOrder(
  iniArchives: readonly string[],
  loadOrder: readonly LoadOrderEntry[],
  presentArchives: readonly string[],
): string[] {
  const present = new Map(presentArchives.map((name) => [asciiLowerCase(name), name]));
  const result: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    const key = asciiLowerCase(name);
    const actual = present.get(key);
    if (actual === undefined || seen.has(key)) return;
    seen.add(key);
    result.push(actual);
  };

  for (const name of iniArchives) add(name);
  for (const plugin of loadOrder) {
    const base = plugin.name.slice(0, plugin.name.lastIndexOf('.'));
    add(`${base}.bsa`);
    add(`${base} - Textures.bsa`);
  }
  return result;
}

/** `FE:001` for light plugins, `05` for full ones. */
export function formatModIndex(entry: LoadOrderEntry): string {
  const hex = (value: number, width: number): string =>
    value.toString(16).toUpperCase().padStart(width, '0');
  return entry.lightIndex === undefined ? hex(entry.modIndex, 2) : `FE:${hex(entry.lightIndex, 3)}`;
}
