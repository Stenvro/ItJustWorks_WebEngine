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
  /** MAST: the plugins it needs loaded before it (none known if the record was unreadable). */
  readonly masters?: readonly string[] | undefined;
}

export type PluginSource = 'implicit' | 'Skyrim.ccc' | 'plugins.txt';

export interface LoadOrderEntry {
  readonly name: string;
  readonly isMaster: boolean;
  readonly isLight: boolean;
  /** 0x00-0xFD, or 0xFE for light plugins. */
  readonly modIndex: number;
  /** 0x000-0xFFF within 0xFE; light plugins only. */
  readonly lightIndex: number | undefined;
  readonly source: PluginSource;
}

export interface LoadOrderResult {
  readonly entries: readonly LoadOrderEntry[];
  readonly problems: readonly string[];
  /** Active plugins not loaded for a missing or inactive master (lower case → the reason). */
  readonly refused: ReadonlyMap<string, string>;
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
  const refused = refuseMissingMasters(sorted, present, problems);

  const entries: LoadOrderEntry[] = [];
  let full = 0;
  let light = 0;
  for (const plugin of sorted) {
    if (refused.has(asciiLowerCase(plugin.name))) continue;
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
  return { entries, problems, refused };
}

/**
 * A plugin whose master (MAST) is missing from Data or not active is not loaded, and so in turn
 * are the plugins that need it (the game refuses such a plugin rather than load records that
 * point into a file it lacks). Returns the refused plugins (lower case) with the reason; a
 * master that loads after a plugin needing it is reported but loaded.
 * TODO(M13): what the original does with a master loading after its dependent (LOOT and
 * libloadorder call that order invalid; the game is not documented to refuse it).
 */
function refuseMissingMasters(
  sorted: readonly { readonly name: string }[],
  present: ReadonlyMap<string, PluginCandidate>,
  problems: string[],
): Map<string, string> {
  const refused = new Map<string, string>();
  const mastersOf = (name: string): readonly string[] =>
    present.get(asciiLowerCase(name))?.masters ?? [];
  // Refusing one can refuse those that need it: repeat until nothing changes.
  for (let changed = true; changed;) {
    changed = false;
    const loaded = new Set(
      sorted.map((p) => asciiLowerCase(p.name)).filter((key) => !refused.has(key)),
    );
    for (const plugin of sorted) {
      const key = asciiLowerCase(plugin.name);
      if (refused.has(key)) continue;
      const lacking = mastersOf(plugin.name).find((master) => !loaded.has(asciiLowerCase(master)));
      if (lacking === undefined) continue;
      const why = present.has(asciiLowerCase(lacking)) ? 'is not active' : 'is missing';
      const reason = `its master ${lacking} ${why}`;
      refused.set(key, reason);
      problems.push(`${plugin.name} not loaded: ${reason}`);
      changed = true;
    }
  }
  const position = new Map(sorted.map((p, i) => [asciiLowerCase(p.name), i]));
  sorted.forEach((plugin, i) => {
    if (refused.has(asciiLowerCase(plugin.name))) return;
    for (const master of mastersOf(plugin.name)) {
      if ((position.get(asciiLowerCase(master)) ?? -1) > i) {
        problems.push(`${plugin.name} loads before its master ${master}`);
      }
    }
  });
  return refused;
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

/**
 * The archives of the game's own content (lower case): the default INI's list and those of
 * the plugins the game loads by itself (its masters and Skyrim.ccc's Creations), not those of
 * plugins.txt (mods). A file the game's content names that none of them holds is one the game
 * itself lacks (a vanilla mesh naming a texture never shipped), no fault of the load order.
 */
export function gameContentArchives(
  iniArchives: readonly string[],
  loadOrder: readonly LoadOrderEntry[],
): Set<string> {
  const names = new Set(iniArchives.map((name) => asciiLowerCase(name)));
  for (const plugin of loadOrder) {
    if (plugin.source === 'plugins.txt') continue;
    const base = asciiLowerCase(plugin.name.slice(0, plugin.name.lastIndexOf('.')));
    names.add(`${base}.bsa`);
    names.add(`${base} - textures.bsa`);
  }
  return names;
}

/** `FE:001` for light plugins, `05` for full ones. */
/**
 * The Creations every Skyrim Special Edition gets (since 1.6.640: Fish, Survival Mode, Rare
 * Curios, Saints & Seducers) and the resource pack they share; any other Creation in
 * Skyrim.ccc came with the Anniversary Upgrade or was bought.
 */
const FREE_CREATIONS = new Set([
  'ccbgssse001-fish.esm',
  'ccqdrsse001-survivalmode.esl',
  'ccbgssse037-curios.esl',
  'ccbgssse025-advdsgs.esm',
  '_resourcepack.esl',
]);

/**
 * Whether the load order has Creations beyond the free ones: the main menu then shows the
 * Anniversary logo (inferred: the game asks its store for the upgrade, which installs them).
 */
export function hasAnniversaryContent(entries: readonly LoadOrderEntry[]): boolean {
  return entries.some(
    (entry) => entry.source === 'Skyrim.ccc' && !FREE_CREATIONS.has(entry.name.toLowerCase()),
  );
}

export function formatModIndex(entry: LoadOrderEntry): string {
  const hex = (value: number, width: number): string =>
    value.toString(16).toUpperCase().padStart(width, '0');
  return entry.lightIndex === undefined ? hex(entry.modIndex, 2) : `FE:${hex(entry.lightIndex, 3)}`;
}
