// Virtueel bestandssysteem: losse bestanden in Data/ gaan altijd voor; daarna wint het
// archief dat het laatst geladen wordt. Zie docs/formats/load-order.md.

import { BsaArchive, type BsaEntry } from '../formats/bsa/bsa.ts';
import {
  PLUGIN_HEADER_SIZE,
  parsePluginHeader,
  type PluginHeader,
} from '../formats/esm/plugin-header.ts';
import { parseIni } from '../formats/ini/ini.ts';
import { normalizePath } from '../formats/paths.ts';
import { decodeWindows1252 } from '../formats/text.ts';
import type { GameFolder } from './game-folder.ts';
import {
  archiveListFromIni,
  computeArchiveOrder,
  computeLoadOrder,
  type LoadOrderEntry,
} from './load-order.ts';

export interface MountedArchive {
  readonly name: string;
  readonly archive: BsaArchive;
  /** Hoger wint bij conflicten. */
  readonly priority: number;
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
  /** Bestand of onderdeel waar het om gaat. */
  readonly source: string;
  readonly message: string;
}

export interface MountOptions {
  /** Inhoud van plugins.txt (mods). Zonder: alleen vaste masters en Creation Club. */
  readonly pluginsTxt?: string;
  /** Controleer alle hashes in de archieven (langzamer; voor tools en tests). */
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
const IN_SUBFOLDER = /[\\/]/;

export class Vfs {
  readonly loadOrder: readonly LoadOrderEntry[];
  /** Laag → hoog. */
  readonly archives: readonly MountedArchive[];
  readonly problems: readonly VfsProblem[];
  /** Skyrim.ccc was bereikbaar (anders zijn Creation Club-plugins niet actief). */
  readonly hasCreationClubList: boolean;
  readonly #folder: GameFolder;
  readonly #files: ReadonlyMap<string, VfsFile>;
  /** Archieven zonder namen, hoog → laag; die worden op hash doorzocht. */
  readonly #hashOnly: readonly MountedArchive[];

  private constructor(init: {
    folder: GameFolder;
    loadOrder: readonly LoadOrderEntry[];
    archives: readonly MountedArchive[];
    problems: readonly VfsProblem[];
    hasCreationClubList: boolean;
    files: ReadonlyMap<string, VfsFile>;
  }) {
    this.#folder = init.folder;
    this.loadOrder = init.loadOrder;
    this.archives = init.archives;
    this.problems = init.problems;
    this.hasCreationClubList = init.hasCreationClubList;
    this.#files = init.files;
    this.#hashOnly = init.archives.filter((a) => !a.archive.hasNames).reverse();
  }

  /**
   * Bouwt de VFS op: laadvolgorde, archieven openen, index samenvoegen.
   * Corrupte of onleesbare bestanden worden overgeslagen en gemeld in `problems`.
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
    const readHeader = async (name: string): Promise<PluginHeader | undefined> => {
      try {
        const source = await folder.openDataFile(name);
        try {
          return parsePluginHeader(await source.read(0, Math.min(PLUGIN_HEADER_SIZE, source.size)));
        } finally {
          await source.close?.();
        }
      } catch (error) {
        problems.push({ source: name, message: describe(error) });
        return undefined;
      }
    };

    const [ccc, iniText, plugins] = await Promise.all([
      readRootText('Skyrim.ccc'),
      readRootText('Skyrim_Default.ini'),
      Promise.all(
        rootFiles
          .filter((name) => PLUGIN_FILE.test(name))
          .map(async (name) => ({ name, header: await readHeader(name) })),
      ),
    ]);

    const order = computeLoadOrder({ plugins, ccc, pluginsTxt: options.pluginsTxt });
    problems.push(...order.problems.map((message) => ({ source: 'load order', message })));
    if (ccc === undefined) {
      problems.push({
        source: 'Skyrim.ccc',
        message: 'not reachable; Creation Club plugins are not loaded',
      });
    }

    const archiveNames = computeArchiveOrder(
      archiveListFromIni(iniText === undefined ? undefined : parseIni(iniText)),
      order.entries,
      rootFiles.filter((name) => ARCHIVE_FILE.test(name)),
    );
    const opened = await Promise.allSettled(
      archiveNames.map(async (name) => {
        const source = await folder.openDataFile(name);
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
        archives.push({ name, archive: result.value, priority: archives.length });
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
      hasCreationClubList: ccc !== undefined,
      files,
    });
  }

  /** Aantal unieke paden (losse bestanden en archiefbestanden met naam). */
  get fileCount(): number {
    return this.#files.size;
  }

  /** Waar een pad vandaan komt, of `undefined` als het niet bestaat. */
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

  /** Leest een bestand; gooit VfsNotFoundError als het niet bestaat. */
  async read(path: string): Promise<Uint8Array> {
    const file = this.resolve(path);
    if (!file) throw new VfsNotFoundError(path);
    return this.readFile(file);
  }

  async readFile(file: VfsFile): Promise<Uint8Array> {
    if (file.kind === 'archive') return file.archive.archive.read(file.entry);
    const source = await this.#folder.openDataFile(file.relativePath);
    try {
      return await source.read(0, source.size);
    } finally {
      await source.close?.();
    }
  }

  /** Alle paden onder een map (recursief), gesorteerd. Archieven zonder namen tellen niet mee. */
  list(folder: string): string[] {
    const prefix = normalizePath(folder);
    const start = prefix === '' ? '' : `${prefix}\\`;
    return [...this.#files.keys()].filter((path) => path.startsWith(start)).sort();
  }

  async close(): Promise<void> {
    await Promise.all(this.archives.map((mounted) => mounted.archive.close()));
  }
}
