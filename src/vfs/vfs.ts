// Virtual file system: loose files in Data/ always take precedence; after that the
// archive loaded last wins. See docs/formats/load-order.md.

import {
  BsaArchive,
  decodeBsaPayload,
  type BsaEntry,
  type BsaPayload,
} from '../formats/bsa/bsa.ts';
import {
  PLUGIN_HEADER_SIZE,
  parsePluginHeader,
  parsePluginMasters,
} from '../formats/esm/plugin-header.ts';
import { parseRecordHeader, RECORD_HEADER_SIZE } from '../formats/esm/record.ts';
import { BlockCache, DEFAULT_BLOCK_SIZE } from '../formats/block-cache.ts';
import { MemoryByteSource, type ByteSource } from '../formats/byte-source.ts';
import { mergeIni, parseIni, type Ini } from '../formats/ini/ini.ts';
import { normalizePath } from '../formats/paths.ts';
import { asciiLowerCase, decodeWindows1252 } from '../formats/text.ts';
import type { GameFolder } from './game-folder.ts';
import {
  archiveListFromIni,
  computeArchiveOrder,
  computeLoadOrder,
  gameContentArchives,
  type LoadOrderEntry,
  type PluginCandidate,
} from './load-order.ts';

/** The name without its extension: `Dawnguard` for `Dawnguard.esm`. */
function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? name : name.slice(0, dot);
}

export interface MountedArchive {
  readonly name: string;
  readonly archive: BsaArchive;
  /** Higher wins on conflicts. */
  readonly priority: number;
  /** One of the game's own archives (load-order.ts gameContentArchives), not a mod's. */
  readonly gameContent: boolean;
}

export type VfsFile =
  | { readonly kind: 'loose'; readonly path: string; readonly relativePath: string }
  | {
      readonly kind: 'archive';
      readonly path: string;
      readonly archive: MountedArchive;
      readonly entry: BsaEntry;
    };

export interface VfsProblem {
  /** File or component concerned. */
  readonly source: string;
  readonly message: string;
}

export interface MountOptions {
  /** Contents of plugins.txt (mods). Without it: only implicit masters and Creation Club. */
  readonly pluginsTxt?: string | undefined;
  /** The player's Skyrim.ini (Documents\My Games), over the installation's Skyrim_Default.ini. */
  readonly skyrimIni?: string | undefined;
  /** The player's SkyrimPrefs.ini, over Skyrim.ini. */
  readonly skyrimPrefsIni?: string | undefined;
  /** Verify all hashes in the archives (slower; for tools and tests). */
  readonly verifyHashes?: boolean;
}

export class VfsNotFoundError extends Error {
  override readonly name = 'VfsNotFoundError';
  readonly path: string;

  constructor(path: string) {
    super(`File not found: ${path}`);
    this.path = path;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PLUGIN_FILE = /\.(esm|esp|esl)$/i;
const ARCHIVE_FILE = /\.bsa$/i;
/** The archives' blocks kept at most (16 MB): most of their files are read once. */
const ARCHIVE_CACHE_BYTES = 16 * 1024 * 1024;
const IN_SUBFOLDER = /[\\/]/;

export class Vfs {
  readonly loadOrder: readonly LoadOrderEntry[];
  /** Low → high. */
  readonly archives: readonly MountedArchive[];
  readonly problems: readonly VfsProblem[];
  /** Skyrim.ccc was reachable (otherwise Creation Club plugins are inactive). */
  readonly hasCreationClubList: boolean;
  /** Skyrim.ccc's text, if it was reachable. */
  readonly creationClubList: string | undefined;
  /** Skyrim_Default.ini of the installation, if it was readable. */
  readonly defaultIni: Ini | undefined;
  /**
   * The INI settings the engine reads: Skyrim_Default.ini < the player's Skyrim.ini <
   * SkyrimPrefs.ini < `<Plugin>.ini` in Data for each loaded plugin, in load order.
   */
  readonly ini: Ini;
  /** The plugin INIs that were read, in the order they were layered. */
  readonly pluginInis: readonly string[];
  /** Every plugin in Data with its header and masters (for the plugin screen). */
  readonly plugins: readonly PluginCandidate[];
  /** Active plugins not loaded for a missing or inactive master (lower case → the reason). */
  readonly refused: ReadonlyMap<string, string>;
  readonly #folder: GameFolder;
  readonly #files: ReadonlyMap<string, VfsFile>;
  /** Archives without names, high → low; these are searched by hash. */
  readonly #hashOnly: readonly MountedArchive[];
  /**
   * The archives' small files are read through it: files read one after another from one
   * folder (a script's parents, a cell's meshes) mostly share a block read once.
   */
  readonly blocks: BlockCache;

  private constructor(init: {
    folder: GameFolder;
    loadOrder: readonly LoadOrderEntry[];
    archives: readonly MountedArchive[];
    problems: readonly VfsProblem[];
    creationClubList: string | undefined;
    defaultIni: Ini | undefined;
    ini: Ini;
    pluginInis: readonly string[];
    plugins: readonly PluginCandidate[];
    refused: ReadonlyMap<string, string>;
    files: ReadonlyMap<string, VfsFile>;
    blocks: BlockCache;
  }) {
    this.ini = init.ini;
    this.pluginInis = init.pluginInis;
    this.plugins = init.plugins;
    this.refused = init.refused;
    this.#folder = init.folder;
    this.blocks = init.blocks;
    this.loadOrder = init.loadOrder;
    this.archives = init.archives;
    this.problems = init.problems;
    this.creationClubList = init.creationClubList;
    this.hasCreationClubList = init.creationClubList !== undefined;
    this.defaultIni = init.defaultIni;
    this.#files = init.files;
    this.#hashOnly = init.archives.filter((a) => !a.archive.hasNames).reverse();
  }

  /**
   * Builds the VFS: load order, open archives, merge the index.
   * Corrupt or unreadable files are skipped and reported in `problems`.
   */
  static async mount(folder: GameFolder, options: MountOptions = {}): Promise<Vfs> {
    const problems: VfsProblem[] = [];
    const dataFiles = await folder.listDataFiles();
    const rootFiles = dataFiles.filter((path) => !IN_SUBFOLDER.test(path));

    const readRootText = async (name: string): Promise<string | undefined> => {
      try {
        const bytes = await folder.readRootFile(name);
        return bytes && decodeWindows1252(bytes);
      } catch (error) {
        problems.push({ source: name, message: describe(error) });
        return undefined;
      }
    };
    // The TES4 record: its flags (master, light) and its masters (MAST).
    const readHeader = async (name: string): Promise<PluginCandidate> => {
      try {
        const source = await folder.openDataFile(name);
        try {
          const top = await source.read(0, Math.min(RECORD_HEADER_SIZE, source.size));
          const header = parsePluginHeader(top.subarray(0, PLUGIN_HEADER_SIZE));
          const { dataSize } = parseRecordHeader(top);
          if (RECORD_HEADER_SIZE + dataSize > source.size) {
            throw new Error(`TES4 record of ${dataSize} bytes runs past the end of the file`);
          }
          const data = await source.read(RECORD_HEADER_SIZE, dataSize);
          return { name, header, masters: parsePluginMasters(data) };
        } finally {
          await source.close?.();
        }
      } catch (error) {
        problems.push({ source: name, message: describe(error) });
        return { name, header: undefined };
      }
    };

    const [ccc, iniText, plugins] = await Promise.all([
      readRootText('Skyrim.ccc'),
      readRootText('Skyrim_Default.ini'),
      Promise.all(rootFiles.filter((name) => PLUGIN_FILE.test(name)).map(readHeader)),
    ]);

    const order = computeLoadOrder({ plugins, ccc, pluginsTxt: options.pluginsTxt });
    problems.push(...order.problems.map((message) => ({ source: 'load order', message })));
    if (ccc === undefined) {
      problems.push({
        source: 'Skyrim.ccc',
        message: 'not reachable; Creation Club plugins are not loaded',
      });
    }

    // The settings, layered: the installation's default, the player's two files, then each
    // loaded plugin's own INI in Data (`<Plugin>.ini`), in load order.
    const defaultIni = iniText === undefined ? undefined : parseIni(iniText);
    const rootByName = new Map(rootFiles.map((name) => [asciiLowerCase(name), name]));
    const pluginInis = order.entries
      .map((entry) => rootByName.get(asciiLowerCase(`${baseName(entry.name)}.ini`)))
      .filter((name) => name !== undefined);
    const pluginIniTexts = await Promise.all(
      pluginInis.map(async (name) => {
        try {
          const source = await folder.openDataFile(name);
          try {
            return parseIni(decodeWindows1252(await source.read(0, source.size)));
          } finally {
            await source.close?.();
          }
        } catch (error) {
          problems.push({ source: name, message: describe(error) });
          return undefined;
        }
      }),
    );
    const userIni = (text: string | undefined): Ini | undefined =>
      text === undefined ? undefined : parseIni(text);
    const ini = mergeIni([
      defaultIni,
      userIni(options.skyrimIni),
      userIni(options.skyrimPrefsIni),
      ...pluginIniTexts,
    ]);
    const iniArchives = archiveListFromIni(ini);
    const archiveNames = computeArchiveOrder(
      iniArchives,
      order.entries,
      rootFiles.filter((name) => ARCHIVE_FILE.test(name)),
    );
    // The game's own: the default INI's list, not what the player's or a mod's INI adds.
    const official = gameContentArchives(archiveListFromIni(defaultIni), order.entries);
    const blocks = new BlockCache(DEFAULT_BLOCK_SIZE, ARCHIVE_CACHE_BYTES);
    const opened = await Promise.allSettled(
      archiveNames.map(async (name) => {
        const source = blocks.wrap(await folder.openDataFile(name));
        try {
          return await BsaArchive.open(source, { verifyHashes: options.verifyHashes ?? false });
        } catch (error) {
          await source.close?.();
          throw error;
        }
      }),
    );
    const archives: MountedArchive[] = [];
    opened.forEach((result, i) => {
      const name = archiveNames[i] ?? '?';
      if (result.status === 'fulfilled') {
        archives.push({
          name,
          archive: result.value,
          priority: archives.length,
          gameContent: official.has(asciiLowerCase(name)),
        });
      } else {
        problems.push({ source: name, message: describe(result.reason) });
      }
    });

    const files = new Map<string, VfsFile>();
    for (const mounted of archives) {
      for (const entry of mounted.archive.entries) {
        if (entry.path !== undefined) {
          files.set(entry.path, { kind: 'archive', path: entry.path, archive: mounted, entry });
        }
      }
    }
    for (const relativePath of dataFiles) {
      const path = normalizePath(relativePath);
      files.set(path, { kind: 'loose', path, relativePath });
    }

    return new Vfs({
      folder,
      loadOrder: order.entries,
      archives,
      problems,
      creationClubList: ccc,
      defaultIni,
      ini,
      pluginInis,
      plugins,
      refused: order.refused,
      files,
      blocks,
    });
  }

  /** Number of unique paths (loose files and named archive files). */
  get fileCount(): number {
    return this.#files.size;
  }

  /** Where a path comes from, or `undefined` if it does not exist. */
  resolve(path: string): VfsFile | undefined {
    const key = normalizePath(path);
    const found = this.#files.get(key);
    if (found?.kind === 'loose') return found;
    for (const mounted of this.#hashOnly) {
      if (found && found.archive.priority > mounted.priority) break;
      const entry = mounted.archive.get(key);
      if (entry) return { kind: 'archive', path: key, archive: mounted, entry };
    }
    return found;
  }

  has(path: string): boolean {
    return this.resolve(path) !== undefined;
  }

  /**
   * Whether a path comes from the game's own archives (its masters', its Creations', the
   * default INI's list): what the game ships, not a mod's archive or a loose file.
   */
  isGameContent(path: string): boolean {
    const file = this.resolve(path);
    return file?.kind === 'archive' && file.archive.gameContent;
  }

  /** Reads a file; throws VfsNotFoundError if it does not exist. */
  async read(path: string): Promise<Uint8Array> {
    const file = this.resolve(path);
    if (!file) throw new VfsNotFoundError(path);
    return this.readFile(file);
  }

  /**
   * Random access to a file: loose files are read on demand (plugins can be hundreds of
   * MB); a file inside an archive is decompressed into memory first.
   */
  async openSource(path: string): Promise<ByteSource> {
    const file = this.resolve(path);
    if (!file) throw new VfsNotFoundError(path);
    if (file.kind === 'loose') return this.#folder.openDataFile(file.relativePath);
    return new MemoryByteSource(await this.readFile(file));
  }

  async readFile(file: VfsFile): Promise<Uint8Array> {
    return decodeBsaPayload(await this.readFilePayload(file));
  }

  /**
   * Reads a file's stored bytes without decompressing them (see `decodeBsaPayload`), so a
   * worker can do the decompression. Throws VfsNotFoundError if the path does not exist.
   */
  async readPayload(path: string): Promise<BsaPayload> {
    const file = this.resolve(path);
    if (!file) throw new VfsNotFoundError(path);
    return this.readFilePayload(file);
  }

  async readFilePayload(file: VfsFile): Promise<BsaPayload> {
    if (file.kind === 'archive') return file.archive.archive.readPayload(file.entry);
    const source = await this.#folder.openDataFile(file.relativePath);
    try {
      const bytes = await source.read(0, source.size);
      return { bytes, compressed: false, originalSize: bytes.length };
    } finally {
      await source.close?.();
    }
  }

  /** All paths under a folder (recursive), sorted. Archives without names are not included. */
  list(folder: string): string[] {
    const prefix = normalizePath(folder);
    const start = prefix === '' ? '' : `${prefix}\\`;
    return [...this.#files.keys()].filter((path) => path.startsWith(start)).sort();
  }

  async close(): Promise<void> {
    await Promise.all(this.archives.map((mounted) => mounted.archive.close()));
  }
}
